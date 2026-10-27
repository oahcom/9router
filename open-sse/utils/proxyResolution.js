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
const PRIVATE_HOST_RE = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;

export function isPrivateHost(hostname) {
  return PRIVATE_HOST_RE.test(normalizeString(hostname));
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
  if (isPrivateHost(hostname)) return null;

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

  return normalizeProxyUrl(proxyUrlRaw);
}

export function resolveEffectiveProxyUrl(targetUrl, proxyOptions = null) {
  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  if (connectionProxyUrl) return { url: connectionProxyUrl, source: "connection" };

  const envProxyUrl = normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  if (envProxyUrl) return { url: envProxyUrl, source: "env" };

  return { url: null, source: "direct" };
}
