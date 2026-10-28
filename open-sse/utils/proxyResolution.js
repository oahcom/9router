export function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

// Hosts that cannot be reached through a remote egress no matter what the proxy
// is: loopback and RFC1918 peers live on this machine's own network. Sending
// them to a public proxy exit is not "slower", it is unreachable — sing-box
// hands 192.168.x.x to its 83-node public pool and every hop answers 502.
// Measured 2026-10-28: `outboundProxyEnabled` exports HTTPS_PROXY process-wide,
// so a LAN peer (192.168.1.97:20127) rode that env proxy and burned 235s per
// attempt to a connect timeout, 108 failures / 0 successes in 30 minutes.
// NO_PROXY cannot carry this: it matches exact hosts or suffixes, never CIDR.
//
// Prefix matching on the raw string was wrong in both directions: "10." marked
// 10.example.com private (leaking the real exit IP for a public host) and the
// literal forms Node/WHATWG URL can emit — "[::ffff:c0a8:161]" for an
// IPv4-mapped address, "[fe80::1]" link-local, CGNAT 100.64/10, "0.0.0.0" —
// were all treated as public (routed to the pool). Ranges below are compared
// numerically and only ever applied to real IP literals.
const PRIVATE_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback", "metadata.google.internal"]);
// ".lan" is not a delegated TLD but is the common shorthand for LAN peers; a
// public host can never end in it.
const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];

// 云元数据端点里，有几个地址无法靠「段」与普通内网对等体区分开：
// 100.64/10 同时是 tailnet 与 CGNAT，fc00::/7 同时是局域网 IPv6，`.internal`
// 是本机自己服务在用的后缀（本仓 test fixture 就有 tgi.internal）。
// 整段拒绝会为了堵四个名字而掐断真实出口，所以按 provider 公布的**具体地址**列出。
const METADATA_V4_HOSTS = [
  "100.100.100.200", // Aliyun
  "168.63.129.16", // Azure WireServer / IMDS 虚拟 IP
  "192.0.0.192", // Oracle Cloud
].map(ipv4ToInt);
const METADATA_V6_HOSTS = new Set(["fd00:ec2::254"]); // AWS IMDS over IPv6
const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.internal",
  "instance-data.ec2.internal",
]);

const PRIVATE_V4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, also used by tailnets and some metadata proxies
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

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

function isPrivateV4Int(ip) {
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

// "[::ffff:192.168.1.97]" and the hex form URL parsing produces for the same
// address ("[::ffff:c0a8:161]") must resolve to the same integer.
function mappedV4ToInt(host) {
  const match = /^::ffff:(.+)$/.exec(host);
  if (!match) return null;
  return ipv4ToInt(match[1]) ?? (() => {
    const hextets = match[1].split(":");
    if (hextets.length !== 2 || !hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
    return ((parseInt(hextets[0], 16) << 16) | parseInt(hextets[1], 16)) >>> 0;
  })();
}

function canonicalHost(hostname) {
  let host = normalizeString(hostname).toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host.includes(":") && host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

// Link-local (169.254.0.0/16, fe80::/10) and cloud metadata names are reachable
// only from the machine that owns them, so a configured proxy was already the
// right answer for them. Treating them as "private ⇒ direct" would turn the
// connection proxy setting into an SSRF path to 169.254.169.254: the panel can
// point a connection's baseUrl anywhere, and before this split that request
// rode the proxy and died. 192.168.x.x/10.x stay direct — those are the peers
// this rule exists for.
export function isLinkLocalOrMetadataHost(hostname) {
  const host = canonicalHost(hostname);
  if (!host) return false;
  if (METADATA_HOSTNAMES.has(host)) return true;
  const v4 = ipv4ToInt(host) ?? mappedV4ToInt(host);
  if (v4 !== null) {
    return (v4 & 0xffff0000) >>> 0 === ipv4ToInt("169.254.0.0") || METADATA_V4_HOSTS.includes(v4);
  }
  if (!host.includes(":")) return false;
  // ponytail: 按字面比，不写 IPv6 展开器 —— 生产上唯一调用方传的是
  // new URL(...).hostname，WHATWG 已把 fd00:0ec2:0::254 规约成 fd00:ec2::254。
  // 若要接第三方传的非规约字符串，再补一个 hextet 展开。
  if (METADATA_V6_HOSTS.has(host)) return true;
  const first = parseInt(host.split(":")[0] || "0", 16);
  return Number.isFinite(first) && (first & 0xffc0) === 0xfe80;
}

// 闸门只看字面量，于是 `169.254.169.254.nip.io` / `100.100.100.200.nip.io` 这类
// 通配 DNS 域名整类绕过——字符串不是 IP，解析后才是。实测 2026-10-28：两个名字
// 在修复前拿到 200 SECRET-METADATA，修复后被拒；字面量 169.254.169.254 早在
// 上一道闸门 0ms 被拒。
//
// 边界（刻意如此，不是遗漏）：解析到 loopback / RFC1918 的名字**不**拒。字面量
// 127.0.0.1 / 192.168.x.x 本来就放行——它们是本机对等体，拒掉等于掐断 LAN 出口，
// 且攻击者写 `http://127.0.0.1:<port>` 就绕过，多堵一层不增加任何防护。
// 实测 `127.0.0.1.nip.io` 修复后仍是 200，与字面量 127.0.0.1 完全一致。
//
// 只复核「解析结果是否落在元数据/链路本地」，**不**按 ssrfGuard 的整段私有
// 判据：192.168.x.x / 10.x 是有意走直连的局域网对等体（见上方 isPrivateHost 说明），
// 用 ssrfGuard.assertPublicUrlResolved 会把它们一并拒掉。
// ponytail: 只做一次解析，不复核重定向后的目标——direct 分支走 undici Agent，
// 重定向在该层内部完成，要在那里拦需要接 connect 回调。要堵重定向再往上升。
//
// 这是热路径：它在每个出站请求之前跑，而 undici 之后自己还会再查一次。
// 本机 resolver 实测 p50=229ms、p90=5341ms、max=10008ms（n=24），不设防就是
// 给每个请求白加几秒。所以带 TTL 缓存，并给单次解析设时限：超时就退回
// 「不拒绝」，因为这里的目标是堵名字，不是给正常请求加一道新的失败模式。
const RESOLVE_CACHE_MAX = 256;
const RESOLVE_TIMEOUT_MS = 1500;
const resolvedHostCache = new Map();

function cachePut(host, isMetadata) {
  if (resolvedHostCache.size >= RESOLVE_CACHE_MAX) {
    resolvedHostCache.delete(resolvedHostCache.keys().next().value);
  }
  const ttl = isMetadata ? 60_000 : 10 * 60_000;
  resolvedHostCache.set(host, { isMetadata, expires: Date.now() + ttl });
}

export async function resolvesToLinkLocalOrMetadataHost(hostname, lookupImpl) {
  const host = canonicalHost(hostname);
  if (!host) return false;
  // 字面量 IP 无需解析：上面那个闸门已经判过，dns.lookup 只会原样返回。
  if (ipv4ToInt(host) !== null || host.includes(":")) return false;
  const cached = resolvedHostCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.isMetadata;

  const lookup = lookupImpl || (await import("node:dns")).promises.lookup;
  let timer;
  try {
    // 一次取全部 A/AAAA，避免只看到公网记录而漏掉同名的私网记录。
    const records = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), RESOLVE_TIMEOUT_MS);
      }),
    ]);
    const isMetadata = records.some(({ address }) => isLinkLocalOrMetadataHost(address));
    // 注入的 lookup 是调用方的假数据，不能污染共享缓存。
    if (!lookupImpl) cachePut(host, isMetadata);
    return isMetadata;
  } catch {
    // 解析失败/超时不是安全结论：交给调用方按原有错误路径处理。
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function isPrivateHost(hostname) {
  const host = canonicalHost(hostname);
  if (!host) return false;
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const v4 = ipv4ToInt(host);
  if (v4 !== null) return isPrivateV4Int(v4);

  if (!host.includes(":")) return false;

  const mapped = mappedV4ToInt(host);
  if (mapped !== null) return isPrivateV4Int(mapped);

  if (host === "::" || host === "::1") return true;
  const first = parseInt(host.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}

export function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  let hostname;
  try {
    const parsed = new URL(targetUrl);
    protocol = parsed.protocol;
    hostname = parsed.hostname;
  } catch { return null; }
  if (isPrivateHost(hostname) && !isLinkLocalOrMetadataHost(hostname)) return null;

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

export function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {
    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    return `http://${normalizedInput}`;
  }
}

const PROXY_DEFAULT_PORTS = {
  "http:": 80,
  "https:": 443,
  "socks:": 1080,
  "socks4:": 1080,
  "socks4a:": 1080,
  "socks5:": 1080,
  "socks5h:": 1080,
};

// Identity key for a fixed proxy egress. Two spellings of one downstream must
// not read as two exits: pool egresses are identified by a hash of the URL, so
// "http://127.0.0.1:7890", "http://127.0.0.1:7890/" and "HTTP://127.0.0.1:7890"
// used to hash differently, and a "switch" between them logged a new egress
// while the physical exit never moved. Identity only: credentials dropped,
// default ports filled in, path and query ignored, socks5h folded into socks5
// (same host and port means the same exit). http and socks stay distinct.
export function canonicalProxyKey(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return normalized.toLowerCase();
  }
  let protocol = parsed.protocol.toLowerCase();
  if (protocol === "socks5h:") protocol = "socks5:";
  const port = parsed.port || String(PROXY_DEFAULT_PORTS[protocol] ?? "");
  const hostname = parsed.hostname.toLowerCase();
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${protocol}//${host}${port ? ":" + port : ""}`;
}

export function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  // 连接级代理与 env 代理同罪：把 LAN peer 交给远端出口必然不可达。
  // 例外是链路本地/元数据端点（见 isLinkLocalOrMetadataHost）：它们本来就
  // 只能靠代理挡住，直连等于把面板配置变成 SSRF。
  try {
    const host = new URL(targetUrl).hostname;
    if (isPrivateHost(host) && !isLinkLocalOrMetadataHost(host)) return null;
  } catch { /* 非 URL 目标交给调用方处理 */ }

  return normalizeProxyUrl(proxyUrlRaw);
}

export function resolveEffectiveProxyUrl(targetUrl, proxyOptions = null) {
  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  if (connectionProxyUrl) return { url: connectionProxyUrl, source: "connection" };

  const envProxyUrl = normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  if (envProxyUrl) return { url: envProxyUrl, source: "env" };

  return { url: null, source: "direct" };
}


// 出口闸的单一实现。两个真正发请求的路口都必须过这一道：
//   - proxyFetch.proxyAwareFetch（undici / node 侧）
//   - opencodeTransport.fetchViaTransport（Bun sidecar 侧）
// 只装在其中一个等于没装：OPENCODE_TRANSPORT=auto 时 executor 先问 sidecar，
// proxyAwareFetch 根本不会被调用，panel 把 baseUrl 指到 169.254.169.254
// （或解析到它的域名）照样读得到。
//
// 解析不出主机名的目标直接拒 —— 闸不能因为看不懂就放行。
export async function assertEgressTargetAllowed(url, lookupImpl) {
  let hostname = "";
  let host = String(url);
  try {
    const parsed = new URL(String(url));
    hostname = parsed.hostname;
    host = parsed.host;
  } catch {
    throw new Error(`[EgressGuard] refused unparseable target; ${host}`);
  }
  if (isLinkLocalOrMetadataHost(hostname)) {
    throw new Error(`[EgressGuard] refused link-local/metadata target; ${host}`);
  }
  if (await resolvesToLinkLocalOrMetadataHost(hostname, lookupImpl)) {
    throw new Error(`[EgressGuard] refused host resolving to link-local/metadata; ${host}`);
  }
}
