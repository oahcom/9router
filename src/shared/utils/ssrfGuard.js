// SSRF guard: block internal/private/metadata targets for server-side fetch.
//
// Three layers, each closing a distinct bypass class documented in #3714:
//   1. assertPublicUrl        - synchronous literal-IP/hostname checks (cheap, for
//                                immediate rejection of obviously-bad input at request-build time).
//   2. assertPublicUrlResolved - adds DNS resolution so a hostname that merely
//                                *resolves* to a private/loopback address (e.g. a
//                                nip.io/sslip.io wildcard-DNS domain, or an attacker's
//                                own domain pointed at 127.0.0.1) is also rejected.
//   3. fetchPublic             - wraps fetch() with manual redirect handling so a
//                                validated public URL can't 30x its way to an
//                                internal target without the redirect target being
//                                re-validated through layer 2 first.
//
// Layer 1 alone previously had matching bugs, not just missing coverage: hostname
// checks ran on the raw string without normalizing a trailing dot ("localhost."),
// and the IPv6 check only recognized one textual representation of an IPv4-mapped
// address (dotted "::ffff:a.b.c.d") while Node/WHATWG URL parsing can normalize the
// same address to hex form ("::ffff:7f00:1") — a mismatch, not an oversight.

import dns from "node:dns";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

// Parse dotted IPv4 to 32-bit integer, or null if not a valid IPv4 literal.
function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Private/reserved IPv4 ranges as [startInt, maskBits, reason].
// reason 是审计对账用的：listBlockedRanges() 直接把它吐出来，不必再维护第二张表。
const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8, "\"this network\" (RFC 1122)"],
  [ipv4ToInt("10.0.0.0"), 8, "RFC1918 private"],
  [ipv4ToInt("100.64.0.0"), 10, "CGNAT — also used by some cloud metadata proxies (Aliyun 100.100.100.200)"],
  [ipv4ToInt("127.0.0.0"), 8, "loopback"],
  [ipv4ToInt("169.254.0.0"), 16, "link-local (AWS/GCP/Tencent metadata 169.254.169.254)"],
  // 两个云厂商把元数据端点放在公网可路由的段里，只能按 /32 精确拦：
  // 168.63.0.0/16 与 192.0.0.0/24 含大量正常服务地址，放宽会误杀真实出站。
  [ipv4ToInt("168.63.129.16"), 32, "Azure WireServer / IMDS virtual IP"],
  [ipv4ToInt("192.0.0.192"), 32, "Oracle Cloud IMDS"],
  [ipv4ToInt("172.16.0.0"), 12, "RFC1918 private"],
  [ipv4ToInt("192.168.0.0"), 16, "RFC1918 private"],
];

function isBlockedIpv4Int(ip) {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip);
}

function intToIpv4(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

// 拒绝集合可枚举：审计要能问「现在到底拦了哪些段」，而不是读源码猜。
// 返回 [{cidr, reason}]，reason 供对账；判定内核仍只用 [int, maskBits] 元组。
export function listBlockedRanges() {
  return BLOCKED_V4_RANGES.map(([base, bits, reason]) => ({
    cidr: `${intToIpv4(base)}/${bits}`,
    reason,
  }));
}

function parseHextets(s) {
  if (s === "") return [];
  const segs = s.split(":");
  const out = [];
  for (const seg of segs) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(parseInt(seg, 16));
  }
  return out;
}

// Parse any textual IPv6 representation (including an embedded dotted-IPv4 tail,
// "::" compression in any position, and full/partial forms) into 8 16-bit groups.
// Returns null if the string isn't a valid IPv6 literal. Parsing into groups once
// and reasoning about the numeric value — rather than pattern-matching the source
// string — is what makes this immune to "which textual form did the URL parser
// pick" bugs: "::ffff:127.0.0.1" and "::ffff:7f00:1" produce identical groups.
function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase();

  const v4TailMatch = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4TailMatch) {
    const v4Int = ipv4ToInt(v4TailMatch[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4TailMatch[1].length);
    if (host.endsWith("::")) {
      // "::" compression marker itself — leave both colons, the removed IPv4
      // fills the gap it represents.
    } else if (host.endsWith(":")) {
      host = host.slice(0, -1); // was just the "prevgroup:ipv4" separator
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const head = parseHextets(doubleColonParts[0]);
    const tail = parseHextets(doubleColonParts[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isBlockedIpv6Groups(g) {
  const isZero = (n) => g[n] === 0;
  // loopback ::1
  if ([0, 1, 2, 3, 4, 5, 6].every(isZero) && g[7] === 1) return true;
  // unspecified ::
  if (g.every((x) => x === 0)) return true;
  // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // unique local fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // IPv4-mapped ::ffff:0:0/96 (0:0:0:0:0:ffff:a.b.c.d — the 0xffff marker is
  // group index 5) and NAT64 well-known prefix 64:ff9b::/96 — both embed a
  // real IPv4 address in the low 32 bits; check it against the same IPv4
  // blocklist regardless of which prefix wraps it.
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return isBlockedIpv4Int(low32);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return isBlockedIpv4Int(low32);
  // IPv4-compatible ::a.b.c.d/96 (deprecated, still parseable) — excludes :: and ::1
  // which already matched above.
  if ([0, 1, 2, 3, 4, 5].every(isZero) && low32 !== 0 && low32 !== 1) return isBlockedIpv4Int(low32);
  return false;
}

function normalizeHost(hostname) {
  // A trailing dot marks an FQDN and is semantically insignificant
  // ("localhost." and "localhost" are the same host) but was being compared
  // as a literal character, letting it slip past every string-based check.
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isBlockedHost(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (isBlockedIpv4(host)) return true;
  if (host.includes(":")) {
    const groups = parseIPv6ToGroups(host.replace(/^\[|\]$/g, ""));
    if (groups && isBlockedIpv6Groups(groups)) return true;
  }
  return false;
}

// Throw if URL targets a non-public host by literal hostname/IP alone (no DNS
// resolution — see assertPublicUrlResolved for that). Caller should map to 400.
export function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");
}

// Async: assertPublicUrl plus DNS resolution of non-literal hostnames, so a
// domain that merely *resolves* to a private/loopback/metadata address (wildcard-DNS
// services like nip.io/sslip.io, or an attacker-controlled domain with an A record
// pointed at 127.0.0.1) is rejected too, not just IPs typed directly into the URL.
export async function assertPublicUrlResolved(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");

  // Already a literal IPv4/IPv6 address — isBlockedHost above already covered it,
  // no DNS lookup applies (and dns.lookup would just echo it back anyway).
  const bracketless = host.replace(/^\[|\]$/g, "");
  if (ipv4ToInt(bracketless) !== null || bracketless.includes(":")) return;

  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    // Resolution failure isn't an SSRF signal by itself — let the subsequent
    // fetch() fail with its own (clearer) network error.
    return;
  }
  for (const { address, family } of addresses) {
    if (family === 4 ? isBlockedIpv4(address) : isBlockedIpv6Groups(parseIPv6ToGroups(address) || [])) {
      throw new Error("Blocked URL: hostname resolves to an internal host");
    }
  }
}

// ── 凭据按信任域收敛 ─────────────────────────────────────────────────────
// 凭据只发给「凭据所属主机」：调用方能改目的地（provider_options.baseUrl、
// 上游 302），改目的地即改信任域，跨域那一次请求不再携带本机配置的 key。
// 两条出站路径（proxyFetch 的跳转接管、search 的 builder 覆盖）共用这里的
// 唯一一份判据，避免「改一处漏一处」。

// 凭据头按「上游认得出是凭据」列举：search builder 用 x-api-key /
// x-subscription-token 送 key，只列 authorization 会漏掉这两类。
const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "x-api-key",
  "x-subscription-token",
];

// 凭据放在 query 里的 provider（google-pse 的 key=、searchapi 的 api_key=）。
const CREDENTIAL_QUERY_PARAMS = ["key", "api_key", "apikey", "token", "access_token", "secret"];

export function isCrossOrigin(fromUrl, toUrl) {
  try {
    return new URL(fromUrl).origin !== new URL(toUrl).origin;
  } catch {
    return true; // 解析不出受信基线 → 按跨域处理（失败关闭）
  }
}

export function stripCredentialsForCrossOrigin(headers, fromUrl, toUrl) {
  if (!isCrossOrigin(fromUrl, toUrl)) return headers;
  const stripped = new Headers(headers || {});
  for (const name of CREDENTIAL_HEADERS) stripped.delete(name);
  return stripped;
}

export function stripCredentialQueryParams(url) {
  const parsed = new URL(url);
  let removed = false;
  for (const name of CREDENTIAL_QUERY_PARAMS) {
    if (parsed.searchParams.has(name)) {
      parsed.searchParams.delete(name);
      removed = true;
    }
  }
  return removed ? parsed.toString() : url;
}

// fetch() with SSRF-safe manual redirect handling: each hop's target is
// re-validated through assertPublicUrlResolved before being followed, so a
// validated public URL can't 30x its way to an internal target. Bounded to
// maxRedirects hops (fetch's own default following behavior has no bound
// relevant here since we never let it auto-follow).
// 跨源跳转另外剥掉凭据：原生 fetch 自己会剥（undici 的 CORS non-wildcard
// 分支），接管跳转后就得自己剥，否则 A 回 302 到 B 时 Authorization/Cookie
// 被原样送给第三方。同源跳转保持原 headers（自托管服务补斜杠的 302 不能丢 auth）。
export async function fetchPublic(url, init = {}, { maxRedirects = 5 } = {}) {
  await assertPublicUrlResolved(url);
  let currentUrl = url;
  let currentInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const res = await fetch(currentUrl, currentInit);
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error("Blocked URL: too many redirects");
    const nextUrl = new URL(location, currentUrl).toString();
    await assertPublicUrlResolved(nextUrl);
    // 按累积后的 headers 剥：连跳两次跨源时，第二跳起就不该还带着。
    const nextHeaders = stripCredentialsForCrossOrigin(currentInit.headers, currentUrl, nextUrl);
    if (nextHeaders !== currentInit.headers) currentInit = { ...currentInit, headers: nextHeaders };
    currentUrl = nextUrl;
  }
}
