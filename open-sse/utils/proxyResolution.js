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
