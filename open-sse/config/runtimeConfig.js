// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

function envChoice(name, allowed, def) {
  const raw = process.env[name]?.trim().toLowerCase();
  return allowed.includes(raw) ? raw : def;
}

// Cooldown alignment: when set, a cooldown on an egress 9router controls
// (direct / relay) runs until the next local occurrence of this hour, so a
// free-quota 429 parks the exit until the window actually resets instead of
// for however many seconds upstream happened to hint. Empty = off.
function envHour(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;
}

export const EGRESS_CONFIG = {
  mode: envChoice("EGRESS_PROBE_MODE", ["off", "auto", "always"], "auto"),
  probeUrl: envUrl("EGRESS_PROBE_URL", "https://api64.ipify.org?format=json"),
  probeTimeoutMs: envMs("EGRESS_PROBE_TIMEOUT_MS", 2500),
  ipCacheTtlMs: envMs("EGRESS_IP_CACHE_TTL_MS", 10 * 60 * 1000),
  ipStaleTtlMs: envMs("EGRESS_IP_STALE_TTL_MS", 60 * 60 * 1000),
  directRecheckMs: envMs("EGRESS_DIRECT_RECHECK_MS", 15 * 1000),
  minCooldownMs: envMs("EGRESS_MIN_COOLDOWN_MS", 1000),
  maxCooldownMs: envMs("EGRESS_MAX_COOLDOWN_MS", 24 * 60 * 60 * 1000),
  defaultCooldownMs: envMs("EGRESS_DEFAULT_COOLDOWN_MS", 60 * 1000),
  alignCooldownHour: envHour("EGRESS_COOLDOWN_ALIGN_HOUR"),
  limitMessage: envUrl(
    "EGRESS_LIMIT_MESSAGE",
    "Free usage limit reached on the current egress. Retry after the indicated delay or switch proxies."
  ),
};

export const OPENCODE_TRANSPORT_CONFIG = {
  mode: envChoice("OPENCODE_TRANSPORT", ["off", "auto"], "auto"),
  bunBin: envUrl("OPENCODE_BUN_BIN", "bun"),
  readyTimeoutMs: envMs("OPENCODE_TRANSPORT_READY_TIMEOUT_MS", 8000),
  failureBackoffMs: envMs("OPENCODE_TRANSPORT_BACKOFF_MS", 5 * 60 * 1000),
  // 流式请求等待上游响应头的上限：出口隧道中途重连时 forward 会挂到调用方
  // 中止（实测 60s），期间没有首字节。超时即判定该出口不可用，交给上层换线。
  // 非流式不设限：长生成在响应头返回前就可能超过该值，会误杀。
  headerTimeoutMs: envMs("OPENCODE_TRANSPORT_HEADER_TIMEOUT_MS", 20 * 1000),
  // 换线重放的等待上限。首次 20s 是「快速判死当前出口」的探针，重放再用同一个
  // 20s 就是把同一次失败原样重演一遍：实测 43s = 20s + 20s，两次都撞同一个死
  // 出口后回 503。而重放时 asip 往往回「出口正常，不换线」（它的探针是
  // max_tokens:1 的小请求，小请求能过、大请求挂着），出口地址根本没变 ——
  // 这时唯一能救回请求的就是「多等一会儿」。
  // 实测同一出口首字节随请求体线性增长：1000KB≈7.1s、2000KB≈10s，真实请求
  // p50 就有 452KB，叠上并发排队很容易越 20s。45s 仍在 base 的 60s 连接超时内。
  headerTimeoutReplayMs: envMs("OPENCODE_TRANSPORT_HEADER_TIMEOUT_REPLAY_MS", 45 * 1000),
  // 首字节预算随请求体增长。大 body 的 prefill 本身就慢（实测同一出口
  // 1000KB≈7.1s、2000KB≈10s；p90 444KB 桶 TTFT 27.9s），固定 20s 只够判
  // 小请求，300–600KB 的正常请求会被判成假超时 → 换线 → 503。
  // 每 500KB 加 15s；封顶留在 base 60s 连接超时之前，否则 base 的 connectCtrl
  // 会先 abort，这个数字形同虚设（失败时客户端还要白等满 60s）。
  headerTimeoutPer500kbMs: envMs("OPENCODE_TRANSPORT_HEADER_TIMEOUT_PER_500KB_MS", 15 * 1000),
  headerTimeoutMaxMs: envMs("OPENCODE_TRANSPORT_HEADER_TIMEOUT_MAX_MS", 55 * 1000),
  // 被节流的重置：一次上游超时后就 30s 不许重启 sidecar，这期间撞死 socket 的
  // 请求全部直接 503（6h 实测 11 次重启 vs 20 次节流）。5s 只够挡住同一批并发
  // 请求一起 retire 造成的 spawn 风暴，又不会把后面独立的失败一起挡在门外。
  retryCooldownMs: envMs("OPENCODE_TRANSPORT_RETRY_COOLDOWN_MS", 5 * 1000),
  // 上游 ce060c79 的 wreq-js 兜底（sidecar 不在、又没配代理时才用得上）。
  // 默认 off：那条路从本机 IP 直出，wreq-js 缺失时还会在请求里 npm install。
  tlsFallback: envChoice("OPENCODE_TLS_FALLBACK", ["off", "on"], "off") === "on",
};

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Combo empty-content failover: how long a 2xx stream may be held while waiting for its first
// content-bearing frame before committing to that model (fail-open on expiry).
// Env: EMPTY_PEEK_DEADLINE_MS.
export const EMPTY_PEEK_DEADLINE_MS = envMs("EMPTY_PEEK_DEADLINE_MS", 45 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
