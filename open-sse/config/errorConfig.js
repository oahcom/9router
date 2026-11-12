// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  // Intl gateway blocks affect the account/IP, so let the connection back off.
  { provider: "codebuddy-intl", text: "request illegal", backoff: true },
  { provider: "codebuddy-intl", text: "conversation id missing", backoff: true },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "insufficient credit",      backoff: true },
  { text: "credit balance is too low", backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
  // 5xx 也走指数退避（2026-11-09）：中继 502 的失败请求本身要跑 21~252s
  // 才回错，默认 TRANSIENT_COOLDOWN_MS(30s) 先到期 —— 风暴期每个新请求都
  // 再撞一次死中继（实测 08:53 90s 内 14 连 502）。退避从 2s 起翻倍、上限
  // 5min（BACKOFF_CONFIG.max），连续失败才升级：偶发一次 502 的代价只是
  // 与 429 同源的 2s 冷却。
  { status: 502, backoff: true },
  { status: 503, backoff: true },
  { status: 504, backoff: true },
];

/**
 * 请求体自身超限（上下文溢出）的判别模式 —— 与「凭证是否有问题」无关，
 * 也与「换个成员能不能服务」无关：prompt 已经超出上限，换任何成员都是同一份
 * 超长 body 再传一遍。实测某会话 42 分钟 517 条 400 context_length_exceeded，
 * 全部由「组合层换成员 + 客户端循环重发」放大而来，一次上游尝试就够。
 *
 * 只匹配明确点名「上下文/输入太长」的措辞，不碰通用 400（那类换成员仍可能成功）。
 */
export const CONTEXT_OVERFLOW_PATTERNS = [
  "context_length_exceeded",
  "context length exceeded",
  "maximum context length",
  "exceeds the maximum context length",
  "prompt is too long",
  "input is too long",
  "reduce the length of the messages",
  "exceeds the maximum number of tokens",
];

/** 上下文溢出以这些状态码出现（OpenAI 400、部分网关 413/422）。 */
export const CONTEXT_OVERFLOW_STATUSES = [400, 413, 422];

/**
 * 这条错误是不是「请求体自己超出上下文」。
 * @param {number} status - HTTP 状态码
 * @param {string|object} errorText - 上游错误正文/消息
 * @returns {boolean}
 */
export function isContextOverflowError(status, errorText) {
  if (!CONTEXT_OVERFLOW_STATUSES.includes(status)) return false;
  const text = (typeof errorText === "string" ? errorText : JSON.stringify(errorText ?? "")).toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => text.includes(p));
}

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
