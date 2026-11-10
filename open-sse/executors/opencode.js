import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG, OPENCODE_TRANSPORT_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { applyOpencodeTransportHeaders } from "./opencodeTransportHeaders.js";
import { bumpTransportGeneration, fetchViaTransport } from "../utils/opencodeTransport.js";
import { opencodeTlsFetch } from "../services/opencodeTlsClient.js";
import { normalizeString, resolveEffectiveProxyUrl } from "../utils/proxyResolution.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  asipRotationEnabled,
  rotateEgress,
  currentAsipEgress,
  currentAsipEgressSince,
  markAsipProxyCooling,
} from "../utils/asipRotate.js";
import { classifyRotateReason } from "../utils/egressClassify.js";

function tagWarnWithRequest(log, reqId) {
  if (!log || typeof log.warn !== "function" || !reqId) return log;
  // 给这个请求的每条 warn 追加 (req=xxx)，429/换线时能按 reqId 串起一次请求的全过程。
  //
  // 两个坑，都是踩过的：
  // 1) 不能 {...log}：class logger / 模块导出的 debug·info·errorLine 在原型上，
  //    浅拷贝只复制自有属性，日志会静默消失。
  // 2) 也不能 Object.create(log) 之后直接赋值：log 常常是 webpack 的模块导出对象，
  //    warn 是只有 getter 的访问器，往继承来的访问器上赋值在严格模式下抛
  //    TypeError: Cannot set property warn of #<Object> which has only a getter ——
  //    每个请求直接 502。必须用 defineProperty 建自有数据属性盖住它。
  // 兜底：诊断逻辑再出任何岔子也只是没有后缀，绝不能把请求打死。
  try {
    const warn = log.warn.bind(log);
    const wrapped = Object.create(log);
    Object.defineProperty(wrapped, "warn", {
      value: (tag, message, data) => warn(tag, message + " (req=" + reqId + ")", data),
      writable: true,
      configurable: true,
      enumerable: false,
    });
    // sidecar 在响应头之后断流时也要能按 reqId 对回本次请求；通过日志
    // 上下文传递，保持 fetchViaTransport 的四参数签名与既有调用契约不变。
    Object.defineProperty(wrapped, "opencodeRequestId", {
      value: reqId,
      configurable: true,
      enumerable: false,
    });
    return wrapped;
  } catch {
    return log;
  }
}

// 传输层诊断：有请求上下文就回 tag 体系，没有就退回 console —— 不能因为没 log 而静默。
function warnTransport(log, message) {
  if (log && typeof log.warn === "function") log.warn("TRANSPORT", message);
  else console.warn("[OpenCode] " + message);
}

const DECLINE_LOG_INTERVAL_MS = 60_000;
const declineLogState = new Map();

// 换线被拒的原因按 reason 聚合：429 风暴时每个请求都会撞上同一句，
// 逐条打会淹掉真正的信号，完全不打又等于没有归因（审查发现）。
function logDecline(log, reason, now = Date.now()) {
  const key = String(reason || "unknown");
  const state = declineLogState.get(key) || { at: 0, suppressed: 0 };
  if (now - state.at < DECLINE_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    declineLogState.set(key, state);
    return;
  }
  const suffix = state.suppressed ? " (+" + state.suppressed + " suppressed)" : "";
  declineLogState.set(key, { at: now, suppressed: 0 });
  const line = "asip declined (" + key + "); no retry" + suffix;
  if (log?.warn) log.warn("EGRESS", line);
  else console.warn("[OpenCode] EGRESS " + line);
}

import {
  resolveEgress,
  markEgressCooling,
  getEgressCooldown,
  hasActiveDirectCooldown,
  parseRetryAfterMs,
  syntheticRateLimitResponse,
  describeEgress,
  DIRECT_EGRESS_ID,
  resetEgressState,
} from "../utils/egress.js";

const MAX_LOCAL_COOLDOWN_MS = 60_000;
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { clearProxyDispatchers } from "../utils/proxyFetch.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
const OPENCODE_UA = "opencode/latest/2.0.26/cli";
const OPENCODE_CLIENT = "cli";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// chatCore falls back to `crypto.randomUUID() + Date.now()` for providerSessionId
// when the downstream request carries no session hint. Treating that synthetic
// seed as a real conversation hint gives every request its own upstream session.
const SYNTHETIC_SESSION_SEED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\d{13}$/i;

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}
// Models served by /inference/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_COUNTER_MAX = 16;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter = (counter % SESSION_COUNTER_MAX) + 1;
  return `ses_${descendingTimeHex(timestamp, counter)}${unstableRandom()}`;
}

// Upstream decodes the session prefix as a timestamp and rejects ids whose clock
// is far from the request with a 429 FreeUsageLimitError. Mint translated ids from
// the current clock, then cache per hint + rotation epoch so a conversation keeps
// one session across turns instead of getting a fresh one every request.
const translatedOpencodeSessions = new Map();
const MAX_TRANSLATED_SESSIONS = 1000;

function syntheticTransportError(message, failure = null) {
  const headers = {
    "content-type": "application/json",
    "retry-after": "1",
    "x-transport-error-type": "synthetic",
  };
  // 具体是哪一种传输失败随响应带走，而不是写进某个模块级变量：
  // 那种「最后一次失败」在并发下是别人的。
  // 只放行纯 ASCII 短标签：Head 值里混进中文或换行会让 Response 构造直接抛，
  // 一次 503 就变成 502。
  if (failure && /^[a-z0-9:_.-]{1,64}$/i.test(failure)) headers["x-transport-failure"] = failure;
  return new Response(JSON.stringify({
    type: "error",
    error: { type: "UpstreamTransportError", message },
  }), { status: 503, headers });
}


// 都发生在上游首字节之前，可以安全重放：sidecar 的 19s 定时器先到是
// upstream-timeout，父进程 20s 定时器先到是 header-timeout；连接失败则记为
// upstream-fetch-failed。三者都可能是死 socket，也可能是出口悬挂。
const TRANSPORT_REPLAY_FAILURES = new Set([
  "header-timeout", "upstream-timeout", "upstream-fetch-failed",
]);

// 上游 ce060c79 的 TLS 兜底默认关着：那条路从本机 IP 直出（绕开池子和 ASIP），
// wreq-js 缺失时还会在请求里跑一次 npm install —— 两件事都不该在没人要求时发生。
// 开关在 runtimeConfig 里统一读：OPENCODE_TLS_FALLBACK=on 才开。
const TLS_FALLBACK_ENABLED = OPENCODE_TRANSPORT_CONFIG.tlsFallback;


export function translateSessionId(sessionId, clientTool = "", egressId = "", epoch = 0) {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const key = `${clientTool || "generic"}\0${egressId || "-"}\0${epoch}\0${sessionId || ""}`;
  const existing = translatedOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    translatedOpencodeSessions.delete(key);
    translatedOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const translated = generateSessionId();
  if (translatedOpencodeSessions.size >= MAX_TRANSLATED_SESSIONS) {
    translatedOpencodeSessions.delete(translatedOpencodeSessions.keys().next().value);
  }
  translatedOpencodeSessions.set(key, { sessionId: translated, lastUsed: Date.now() });
  return translated;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// One stable x-opencode-session per downstream identity, evicted after
// MEMORY_CONFIG.sessionTtlMs like the other session stores. Production 429
// bodies carry no timing, so a fresh session per request was assumed to be
// the cost driver; that assumption is unverified — see the 08:00 wall-clock
// window measured in asip's ledger (`.warp_ip_used.json`).
const stableOpencodeSessions = new Map();
const opencodeSessionEpochs = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
  for (const [key, entry] of opencodeSessionEpochs) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      opencodeSessionEpochs.delete(key);
    }
  }
  for (const [key, entry] of translatedOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      translatedOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

function sessionScopeKey(credentials, egressId) {
  return `${identityKey(credentials)}\0${egressId || DIRECT_EGRESS_ID}`;
}

function sessionEpoch(credentials, egressId) {
  return opencodeSessionEpochs.get(sessionScopeKey(credentials, egressId))?.epoch || 0;
}

function rotateSession(credentials, egressId) {
  if (nativeSession(credentials?.rawHeaders)) return false;
  const key = sessionScopeKey(credentials, egressId);
  const current = opencodeSessionEpochs.get(key);
  if (opencodeSessionEpochs.size >= MAX_STABLE_SESSIONS && !current) {
    opencodeSessionEpochs.delete(opencodeSessionEpochs.keys().next().value);
  }
  opencodeSessionEpochs.set(key, { epoch: (current?.epoch || 0) + 1, lastUsed: Date.now() });
  stableOpencodeSessions.delete(key);
  return true;
}

export function stableSessionId(credentials, egressId = "") {
  const key = sessionScopeKey(credentials, egressId);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function firstUserText(body) {
  const arr = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : null;
  if (!arr) return "";
  for (const msg of arr) {
    if (msg?.role !== "user") continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") text += part;
        else if (typeof part?.text === "string") text += part.text;
      }
    }
    if (text.trim()) return text.trim();
  }
  return "";
}

// A per-connection fallback session id is not a conversation id. Key fresh
// conversations by their first user message so distinct chats do not share
// one upstream session, while retries and later turns of the same chat do.
function conversationFingerprint(body, clientTool = "") {
  const text = firstUserText(body);
  if (!text) return "";
  // 只 hash 首条 user 文本：纳入整段历史会让每一轮都变成新会话。
  return crypto.createHash("sha256")
    .update(`${normalizeString(clientTool)}\n${text}`)
    .digest("hex")
    .slice(0, 24);
}

function conversationSessionId(credentials, fingerprint) {
  return `${identityKey(credentials)}:conv:${fingerprint}`;
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool, egressId = "") {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const seed = typeof providerSessionId === "string" && SYNTHETIC_SESSION_SEED_RE.test(providerSessionId.trim())
    ? null
    : providerSessionId;
  const hinted = incoming || normalizeSession(seed);
  if (hinted) return translateSessionId(hinted, clientTool, egressId, sessionEpoch(credentials, egressId));

  const fingerprint = conversationFingerprint(body, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) {
      // The manager's last resort is a per-connection synthetic id, so every
      // fresh conversation on a connection would collapse onto one session.
      const connectionScoped = SYNTHETIC_SESSION_SEED_RE.test(String(viaManager).trim());
      const hint = connectionScoped && fingerprint
        ? conversationSessionId(credentials, fingerprint)
        : viaManager;
      return translateSessionId(hint, clientTool, egressId, sessionEpoch(credentials, egressId));
    }
  }

  if (fingerprint) {
    return translateSessionId(
      conversationSessionId(credentials, fingerprint),
      clientTool,
      egressId,
      sessionEpoch(credentials, egressId)
    );
  }

  return stableSessionId(credentials, egressId);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// Chat Completions lane: the free backend validates reasoning_effort against the
// plain OpenAI enum (none|minimal|low|medium|high|xhigh|max) and answers 400
// "Invalid option" for anything else — including "auto", which adaptive thinking
// (Claude Code's thinking:{type:"adaptive"}) arrives as. Omitting the field lets
// the upstream pick its own default, which is what adaptive means; same rationale
// as the Responses path above, which rejects "unknown variant `auto`".
function dropAdaptiveReasoningEffort(body) {
  if (body?.reasoning_effort === "auto") delete body.reasoning_effort;
}

function cloneRequestBody(body) {
  if (body === null || typeof body !== "object") return body;
  if (typeof structuredClone === "function") {
    try { return structuredClone(body); } catch { }
  }
  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return body;
  }
}

const ERROR_TEXT_LIMIT = 8 * 1024;

// 503 的错误体可能是 SSE：.text() 会等到流结束才返回，把一次失败拖成分钟级。
// 合成 503 走 header 判定，真实上游 503 只读前 8KB 就取消。
async function readResponsePrefixText(response, limit = ERROR_TEXT_LIMIT) {
  try {
    const body = response.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks = [];
    let received = 0;
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        chunks.push(Buffer.from(value));
        received += value.byteLength;
      }
    }
    try { await reader.cancel(); } catch { }
    return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
  } catch {
    return "";
  }
}

async function readResponseText(response) {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool, egressId } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool, egressId);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Free-tier fingerprint tools are required even when an agent client
      // already supplied tools. ZCode/Claude Code requests normally have
      // non-empty tool arrays; skipping cloaking here triggers 403 FreeTierError.
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      dropAdaptiveReasoningEffort(body);
      applyFingerprintTools(body, false, { claude: isMessagesModel(model || body?.model) });
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  // The free gate keys on the TLS ClientHello: Bun (the sidecar) is served, while
  // undici's OpenSSL ClientHello is answered with a quota-shaped 429. So the lane
  // always prefers the sidecar; when the sidecar is down and no proxy is
  // configured, OPENCODE_TLS_FALLBACK=on lets wreq-js send the same cipher list.
  // Otherwise we answer a retryable 503. 带 vercel relay 时留意：proxyAwareFetch 的
  // relay 分支在解析 proxyUrl 之前就 return，directFetch 会被忽略 —— 那种情况下这条
  // 兜底并没有生效，请求仍以 undici 的 ClientHello 走 relay。
  async execute(args) {
    // 在 transformRequest 之前留一份原始 body：无首字节超时的重试要重放请求，
    // 而 transformRequest 是就地改（打指纹、改工具名），拿改过的再跑一次会二次打指纹 → 403。
    const replayBody = cloneRequestBody(args.body);
    // executeInner 里才解析得出出口，会话 id 又依赖出口（translateSessionId 的 key 含
    // egressId）。用 holder 把它实际用过的凭据带出来，重试才不会换一个新会话 ——
    // 上游按会话+指纹双重校验，换会话可能直接 403。
    const usedCredentials = {};
    const result = await this.executeInner({ ...args, usedCredentials });
    const replayCredentials = usedCredentials.value || args.credentials;
    // 重试用 executeInner 包过的 logger：那条 warn 必须带同一个 req= 才能串起来。
    const replayArgs = { ...args, log: usedCredentials.log || args.log, body: replayBody, credentials: replayCredentials };
    const replayContext = {
      requestStartedAt: usedCredentials.requestStartedAt || 0,
      failedEgress: usedCredentials.requestEgress || null,
      failedEgressSince: usedCredentials.requestEgressSince || null,
      proxyUrl: usedCredentials.requestProxyUrl || null,
    };
    return (await this.retryOnceAfterStall(result, replayArgs, replayContext)) ?? result;
  }

  /**
   * 无首字节超时既可能是 sidecar 死连接，也可能是当前出口悬挂。
   * 先让 asip 同步换线，再用新 generation 重放一次；asip 不可用或拒绝换线时，
   * 仍保留原出口新连接重试。只重试一次，避免并发超时放大成换线/请求风暴。
   */
  async retryOnceAfterStall(result, args, context = {}) {
    if (result?.response?.status !== 503) return null;
    if (result.response.headers.get("x-transport-error-type") !== "synthetic") return null;
    const failure = result.response.headers.get("x-transport-failure") || "";
    if (!TRANSPORT_REPLAY_FAILURES.has(failure)) return null;
    if (!args?.body) return null;

    let rotation = null;
    if (asipRotationEnabled()) {
      rotation = await rotateEgress("transport", {
        signal: args?.signal,
        requestStartedAt: context.requestStartedAt || 0,
        failedEgress: context.failedEgress || null,
        failedEgressSince: context.failedEgressSince || null,
        proxyUrl: context.proxyUrl || null,
        reqId: args?.reqId,
      });
    }
    clearProxyDispatchers();
    bumpTransportGeneration();
    args.log?.warn?.(
      "EGRESS",
      `transport stall (${failure}) -> retry once on fresh connection`
      + (rotation ? ` after asip rotation (${rotation.reason})` : " (asip unavailable)")
      + ` with ${Math.round(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs / 1000)}s header budget`,
    );
    // 直接走 BaseExecutor：再回 executeInner 会把 429/asip 逻辑重跑一遍。
    // replayBudget：这一趟是「换线后的第二次机会」，asip 经常判「出口正常」不换
    // 线（它的探针是小请求，小请求能过、大请求挂着），于是出口地址没变；再按
    // 首次的 20s 判死就是把同一次失败重演一遍（实测 43s = 20+20 后 503）。
    // 多端口：asip 给了健康备槽时必须真的改走它，否则 transport 重试仍撞旧端口。
    const replayStartedAt = Date.now();
    const replayResult = await super.execute({
      ...args,
      replayBudget: true,
      proxyOptions: rotation?.switchToUrl
        ? { ...(args.proxyOptions || {}), url: rotation.switchToUrl, enabled: true }
        : args.proxyOptions,
    });
    // 重放走的是 BaseExecutor，绕开了 executeInner 里的 429 处置链。若不在这里
    // 补一次记账，「transport 卡住 → 秒切 → 重放撞 429」这条路径上的失败对系统
    // 零影响：目标出口既不标脏、目标端口也不冷却，随后几分钟会被反复复用
    // （2026-11-10 21:22 实测：同一 /128 被复用 ≥4 次、6分47秒后才被别的请求拉黑）。
    // 只报障记账、绝不再重放，所以不会形成「重放 → 换线 → 重放」循环。
    // proxyUrl 取重放真正走的那台闸：换了端口就是 switchToUrl，没换就是原端口。
    // rotateEgress("rate429") 内部已自带 markAsipProxyCooling(proxyUrl)，
    // asip 侧 finally 也会按既定口径起后台修，这里不重复实现。
    const accountingProxyUrl = rotation?.switchToUrl || context?.proxyUrl || null;
    if (replayResult?.response?.status === 429 && rotation && accountingProxyUrl) {
      try {
        const replayRetryAfterMs = parseRetryAfterMs(
          replayResult.response.headers,
          await readResponseText(replayResult.response),
        );
        const accounted = await rotateEgress("rate429", {
          signal: args?.signal,
          requestStartedAt: replayStartedAt,
          failedEgress: rotation.switchToEgress || context?.failedEgress || null,
          proxyUrl: accountingProxyUrl,
          reqId: args?.reqId,
          retryAfterMs: replayRetryAfterMs || 0,
        });
        args.log?.warn?.(
          "EGRESS",
          `replay 429 -> accounting on ${accountingProxyUrl} (${accounted?.reason ?? "no-reply"}); no second replay`,
        );
      } catch (error) {
        args.log?.warn?.("EGRESS", `replay 429 accounting failed: ${error?.message ?? String(error)}`);
      }
    }
    return replayResult;
  }

  async executeInner(args) {
    const { model, stream, credentials } = args;
    // 请求发出时刻。asip 拿它回溯「这条 429 发出时走的是哪条线」，避免把坏账
    // 记到换线之后的新线上。定义在方法开头：下面两个 rotateEgress 调用点都要用，
    // 定义在原处（约 130 行之后）会让前面那处拿不到。
    const requestStartedAt = Date.now();
    // 这条请求打通的那个出口地址（asip 上一次回给我们的）。429 时原样带回，
    // 让 asip 对照自己的换线表判断「它是不是在本次请求之后被换走了」 ——
    // 是就不用再烧一条新线，重连即可。proxy 模式下客户端探不到这个地址
    // （identifyFixedEgress 对 proxy/relay 一律 ip:null），只能由 asip 给。
    const requestEgress = currentAsipEgress();
    // 那个地址是什么时候接上的。单有地址分不清「已经切走」和「切走之前发出的
    // 429」—— 前者重连即可，后者必须真换线。带上接入时刻，asip 才能判断这个
    // 缓存值在请求发出时是否已经就位。
    const requestEgressSince = currentAsipEgressSince();
    // Every warn this request emits carries its short id, so the EGRESS lines
    // (rotate / cooling) and the final ERROR can be stitched together without
    // guessing from timestamps. Call sites stay untouched.
    const log = tagWarnWithRequest(args.log, args.reqId);
    const proxyOptions = args.proxyOptions || null;

    let targetUrl;
    try {
      targetUrl = this.buildUrl(model, stream, 0, credentials);
    } catch {
      targetUrl = this.config.baseUrl;
    }

    let egress;
    try {
      egress = await resolveEgress({
        targetUrl,
        proxyOptions,
        forceProbe: hasActiveDirectCooldown(),
      });
    } catch (error) {
      log?.debug?.("EGRESS", `resolve failed, failing open: ${error.message}`);
      egress = {
        id: DIRECT_EGRESS_ID,
        kind: "direct",
        confirmed: false,
        ip: null,
        proxyUrl: null,
        relayUrl: null,
      };
    }

    const cooldown = getEgressCooldown(egress);
    if (cooldown && egress.confirmed) {
      // 本地拒绝之前先换一次出口。这里一旦拒绝就是「回带 retry-after 数十小时」
      // 的死锁 —— 后续请求全被本地拦掉，根本走不到下面 429 重试分支。
      // 实测这就是服务不可用的直接原因。
      const rotated = await rotateEgress("rate429", {
        signal: args?.signal,
        requestStartedAt,
        failedEgress: requestEgress,
        failedEgressSince: requestEgressSince,
        proxyUrl: egress?.proxyUrl || null,
        reqId: args?.reqId,
      });
      // 只有真换过线才清冷却 / 重建连接 / 重试。asip 的没换线理由要分开看：
      //   ok / coalesced / too_frequent —— 换线发生在 gap 内（coalesce_ms=800ms；
      //   gap = rate429_guard_sec / 线数）。手里这条连接挂在刚被换下的旧线上，
      //   必须重建后再试一次。
      //   no_warm_standby —— 这次一条线都没换，连接还在原来的隧道上。清冷却等于
      //   抹掉「这个出口刚被拦」的记录，重试必然再 429，只是多烧一次上游。
      //   放它落下去走下面返回 429 + 封顶 retry-after。
      // 白名单而不是黑名单：reason 是 asip 那边的开放词表（还有 timeout /
      // unauthorized / internal_error / unknown…），黑名单每漏一个就等于
      // 「没换线也当换过了」。
      // already_retired 是同一件事的另一面：asip 没换线，但那条隧道**已经**在
      // 这条请求之后被换掉了，手里这条连接还挂在它上面，重连一次就够。
      // line_ok：asip 用同一份指纹实测这条线仍然可用，明确没换线。按 asip
      // 结论重连一次、在同一出口上重试，比换掉一条还能用的线划算。
      // （当前 asip 主链路已不再返回 line_ok，留着是兼容旧版回包。）
      const ROTATED_REASONS = ["ok", "coalesced", "too_frequent",
        "already_retired", "line_ok",];
      // restartRequired 一票否决：没有可用闸口时不要重连重试，本进程马上要
      // 自重启，重试只会打在刚烧掉的原端口上、还撞上进程退出。
      const rotateHappened = ROTATED_REASONS.includes(rotated.reason)
        && !rotated.restartRequired;
      if (rotateHappened) {
        clearProxyDispatchers();
        // Bun sidecar 按 proxy 复用 FetchSession，换 selector 不会动已建连接；
        // 换一个 generation 让它重建 session，否则重试还走旧隧道。
        bumpTransportGeneration();
        resetEgressState();
        log?.warn?.(
          "EGRESS",
          "asip rotated (" + rotated.reason + ") before local 429 -> retry on fresh egress"
        );
        const retryPrepared = this.prepareRequestCredentials({ ...args, egressId: "asip-rotated" });
        const retried = await super.execute({
          ...args,
          log,
          credentials: retryPrepared,
          // asip 指定了另一台 sing-box：这次重试改走它，别在原端口上再撞一次。
          proxyOptions: rotated.switchToUrl
            ? { ...proxyOptions, url: rotated.switchToUrl, enabled: true }
            : proxyOptions,
        });
        if (rotated.switchToUrl && args.usedCredentials) {
          // 后续若因 503 进入 execute() 的重放，必须知道刚发到的是目标端口。
          args.usedCredentials.requestProxyUrl = rotated.switchToUrl;
          args.usedCredentials.requestEgress = rotated.switchToEgress || null;
        }
        if (retried?.response && retried.response.status !== 429) return retried;
        // 目标端口也 429：按本地默认窗口冷却，避免下一条新请求又选中它。
        // 不能套 rotated.avoidPortUntil —— 那是**原端口**的整修截止时刻，挪到
        // 目标端口上很可能已经过去，等于给了一副空冷却。
        if (rotated.switchToUrl) markAsipProxyCooling(rotated.switchToUrl);
      } else if (rotated.reason === "timeout") {
        // 超时 = asip 已经在换、只是没等到回话：这次不重试（结果不确定），
        // 但那条隧道确实在换，必须让 sidecar 重建 —— 否则下一条请求继续骑着它，
        // 和主路径那处 timeout 的处理保持一致。
        clearProxyDispatchers();
        bumpTransportGeneration();
      } else if (rotated.lineChanged) {
        // asip 自己换的线：主循环读库、探测判死、定时轮换这三条路都不经过本进程，
        // 我们手里池化的连接还挂在换下来那条隧道上。不重建就会一直骑到它被重启，
        // 期间每条请求都拿旧出口的 429。
        clearProxyDispatchers();
        bumpTransportGeneration();
      }
      // upstream 的 retry-after 可能是数万秒（实测见过 34842s = 9.7 小时）。
      // 原样透传等于一次 429 就把服务锁死大半天，这才是服务不可用的直接原因。
      // 封顶 60s：宁可让调用方多试几次，也不要静默挂死。
      const retryAfterMs = Math.min(cooldown.retryAfterMs, MAX_LOCAL_COOLDOWN_MS);
      log?.warn?.(
        "EGRESS",
        `${describeEgress(egress)} cooling ${Math.ceil(retryAfterMs / 1000)}s; local 429`
      );
      return {
        response: syntheticRateLimitResponse(retryAfterMs),
        url: targetUrl,
        headers: {},
        transformedBody: args.body,
      };
    }

    const prepared = this.prepareRequestCredentials({ ...args, egressId: egress.id });
    // 交给 execute() 做无首字节重试用：它必须在**原出口、原会话**上重放，
    // 拿 args.credentials 重新 prepare 会因缺 egressId 算出另一个会话 id。
    if (args.usedCredentials) {
      args.usedCredentials.value = prepared;
      args.usedCredentials.log = log;
      args.usedCredentials.requestStartedAt = requestStartedAt;
      // 重放要知道刚才走的是哪台 sing-box：egress 只在本函数作用域里，
      // 重放函数看不到它，必须把它带出来。
      args.usedCredentials.requestProxyUrl = egress?.proxyUrl || null;
      args.usedCredentials.requestEgress = requestEgress;
      args.usedCredentials.requestEgressSince = requestEgressSince;
    }
    // 克隆的触发条件是「这次请求有可能需要重放 body」：asip 换线后要重放一次请求。
    // transformRequest 会就地改 body（打指纹、改工具名），不先克隆就重放等于二次改指纹 → 403。
    const retryBody = asipRotationEnabled() ? cloneRequestBody(args.body) : null;

    let result = await super.execute({ ...args, log, credentials: prepared, proxyOptions });
    if (!result?.response) return result;
    const upstreamStatus = result.response.status;
    if (upstreamStatus !== 429 && upstreamStatus !== 403) return result;

    // 判据在 egressClassify.js 里（纯函数，单测覆盖）：429 一律换；403 只有
    // abusive traffic 才换。FreeTierError 是请求指纹被拒，换 IP 无效。
    // 403 才需要读正文 —— 429 不必为分类克隆一次响应体。
    const rotateReason = classifyRotateReason(
      upstreamStatus,
      upstreamStatus === 403 ? await readResponseText(result.response) : ""
    );
    if (!rotateReason) return result;

    // asip sync rotate: 出口只是个指向 sing-box 的固定 proxy URL，换 IP 只能靠
    // asip 切 sing-box 选择器。切完必须丢掉复用连接，否则重试走的还是旧隧道。
    // 直连出口（含 wreq 兜底）时，切 sing-box 选择器不一定改得了这条请求的去路：
    // 主机把流量交给 sing-box（TUN）时有效，纯粹本机直出时无效。两种情况都可能，
    // 所以这里不跳过重试，只补一句说明 —— 免得日志把「重试后还是 429」说成
    // 「换了出口就好了」，让人去追一个不存在的因果。
    // 路径用 egress.kind 判（direct/proxy/relay 三态，resolveEgress 已经算好），
    // 不拿 resolveEffectiveProxyUrl 的空值去猜：它不认识 vercel relay。
    if (egress.kind === "direct") {
      log?.warn?.(
        "EGRESS",
        `${upstreamStatus} on ${describeEgress(egress)} (${rotateReason}); rotation only helps when the host routes through sing-box`
      );
    }
    if (retryBody || typeof args.body === "string") {
      // 上游 429 的 Retry-After 必须透传给 asip 写 ban_until：默认 60s 回池
      // 与实测 11~13h 的额度封禁严重错配，标脏当天就会被重新选中。
      // readResponseText 用 response.clone()，不影响后面再读一次正文。
      const rotateRetryAfterMs = upstreamStatus === 429
        ? parseRetryAfterMs(result.response.headers, await readResponseText(result.response))
        : null;
      const asip = await rotateEgress(rotateReason, {
        signal: args?.signal,
        requestStartedAt,
        failedEgress: requestEgress,
        failedEgressSince: requestEgressSince,
        proxyUrl: egress?.proxyUrl || null,
        reqId: args?.reqId,
        retryAfterMs: rotateRetryAfterMs || 0,
      });
      // already_retired：asip 没换线，但这条 429 追的地址在请求发出之后已经被
      // 换掉了 —— 手里这条连接还挂在它上面，重连一次就够，不必再烧一条新线。
      // line_ok 与 already_retired 同理：asip 明确说这条线还能用（实测 OK），
      // 没换线。按 asip 结论重连一次，在同一出口上重试即可。
      // restartRequired 一票否决：无可用闸口时不重试，由自重启接管。
      if (!asip.restartRequired
          && (asip.switchedAt >= requestStartedAt
              || asip.reason === "already_retired"
              || asip.reason === "line_ok"
              // 多端口：asip 指定了另一台 sing-box，这次重试就走它。独立进程、
              // 独立连接池，等同于「已经换过出口」。
              || Boolean(asip.switchToUrl))) {
        clearProxyDispatchers();
        // 主路径也必须 bump：sidecar 的 session key 是 proxy|generation，只清 undici
        // dispatcher 不影响 Bun 那边池化的 socket（原请求刚回 429，socket 还在池里）。
        bumpTransportGeneration();
        log?.warn?.("EGRESS", "asip rotated egress (" + asip.reason + ") -> retry once on fresh connection");
        const rotatedResult = await super.execute({
          ...args,
          log,
          credentials: prepared,
          proxyOptions: asip.switchToUrl
            ? { ...proxyOptions, url: asip.switchToUrl, enabled: true }
            : proxyOptions,
          ...(retryBody ? { body: retryBody } : {}),
        });
        if (asip.switchToUrl && args.usedCredentials) {
          // 目标端口失败后若触发外层 transport 重放，context 必须指向 B 而不是 A。
          args.usedCredentials.requestProxyUrl = asip.switchToUrl;
          args.usedCredentials.requestEgress = asip.switchToEgress || null;
        }
        if (rotatedResult?.response
            && rotatedResult.response.status !== 429
            && !(upstreamStatus === 403 && rotatedResult.response.status === 403)) {
          return rotatedResult;
        }
        // 换到目标端口仍 429：目标端口本身也进入短冷却，下条新请求才会避开。
        // avoidPortUntil 描述的是原端口的整修截止时刻，与目标端口无关，不套用。
        if (asip.switchToUrl && rotatedResult?.response?.status === 429) {
          markAsipProxyCooling(asip.switchToUrl);
        }
        result = rotatedResult ?? result;
      } else {
        // 换线被拒（合并 / 节流 / 超时 / 不可用）时不重试：重试会打到同一条被烧的隧道上。
        // 但「为什么没换」必须留在生产日志里 —— 之前写 debug，而服务 LEVEL=INFO，
        // 274 次 429 的换线结论全都不存在（审查发现）。改成按 reason 60s 限流的 WARN。
        // 这是 60s 聚合行，覆盖多个请求，不能贴某一条的 req=（会误导归属）。
        logDecline(args?.log, asip.reason);
        // 超时是「asip 已经在换、只是没等它回话」：那条隧道确实要换了，bump 一次，
        // 免得下一条请求继续骑着它（审查发现）。
        // 同样要 bump 的还有「asip 说这次没换，但出口线和上次不一样」——
        // 合并/节流只说明这一次调用没换线，不代表线没被别处换过（主循环、探测判死）。
        if (asip.reason === "timeout" || asip.lineChanged) {
          // sidecar 的 session 和 undici 的 keep-alive 池都得丢，否则下一条请求
          // 还拴在旧隧道上（和上面早退分支保持一致）。
          clearProxyDispatchers();
          bumpTransportGeneration();
          // bump 本身不打日志，而这条路径正是「没人通知我们、我们自己发现的」——
          // 不留一行就分不清它是真没触发还是触发了但看不见。按 reason 限流复用
          // 同一个聚合器，避免 429 风暴里刷屏。
          logDecline(args?.log, asip.lineChanged ? "line-moved" : "timeout-rebuild");
        }
      }
    }
    const bodyText = await readResponseText(result.response);
    const retryAfterMs = parseRetryAfterMs(result.response.headers, bodyText);
    const ipScoped = /FreeUsageLimitError/.test(bodyText);
    const rotated = ipScoped ? false : rotateSession(prepared, egress.id);

    if (egress.kind === "direct" && !egress.confirmed) {
      try {
        const probed = await resolveEgress({ targetUrl, proxyOptions, forceProbe: true, fresh: true });
        if (probed.confirmed) egress = probed;
      } catch (error) {
        log?.debug?.("EGRESS", `direct probe failed, fail-open: ${error.message}`);
      }
    }

    // 只有在直连出口上换会话重试才有意义：proxy 出口的 IP 由 asip 在固定 URL 底下换，
    // 这里能做过的已经做过了，再打一次必然还是同一个结果。
    const retrySameEgress = rotated && egress.kind === "direct";
    if (!retrySameEgress) {
      // 不重试才标冷却。反过来在同一个出口上重试、又把它标成冷却，两者互相矛盾。
      const cooling = markEgressCooling(egress, retryAfterMs);
      if (cooling) {
        log?.warn?.(
          "EGRESS",
          `${describeEgress(egress)} cooling ${Math.ceil(cooling.retryAfterMs / 1000)}s (429, retry-after ${result.response.headers?.get?.("retry-after") ?? "none"})`
        );
      }
      return result;
    }

    const retryEgress = egress;
    const retryProxyOptions = proxyOptions;
    const retryCredentials = this.prepareRequestCredentials({
      ...args,
      body: retryBody || args.body,
      egressId: retryEgress.id,
    });

    log?.warn?.(
      "EGRESS",
      `${upstreamStatus} on ${describeEgress(egress)} → retry once on ${describeEgress(retryEgress)}`
    );

    const retryResult = await super.execute({
      ...args,
      log,
      body: retryBody || args.body,
      credentials: retryCredentials,
      proxyOptions: retryProxyOptions,
    });

    if (retryResult?.response?.status === 429) {
      const retryText = await readResponseText(retryResult.response);
      markEgressCooling(retryEgress, parseRetryAfterMs(retryResult.response.headers, retryText));
    }
    return retryResult;
  }

  // In-process retries of a synthetic transport failure only burn time; the
  // caller (combo/ASIP) owns egress rotation.
  async computeRetryDelay(response) {
    if (response.status !== 503) return null;
    if (response.headers.get("x-transport-error-type") === "synthetic") return false;
    const text = await readResponsePrefixText(response.clone());
    return /UpstreamTransportError/.test(text) ? false : null;
  }

  /** 兜底出口：把 wreq 的 ClientHello 递给 proxyAwareFetch 的 directFetch。 */
  async fetchViaTlsFallback(url, options, proxyOptions = null, log = null) {
    // 这条车道只有流式（transformRequest 无条件把 body.stream 置 true），而 wreq 的
    // timeout 是整请求超时、到点会把流拦腰 abort —— 所以这条兜底不设 timeout，
    // 终止只靠调用方的 signal（客户端断开）。
    //
    const tlsDirectFetch = (target, init) =>
      opencodeTlsFetch(
        target,
        { method: init.method, headers: init.headers, body: init.body },
        { signal: init.signal, timeoutMs: null },
      );
    try {
      return await proxyAwareFetch(url, { ...options, directFetch: tlsDirectFetch }, proxyOptions);
    } catch (error) {
      // 客户端自己断了要原样往上抛：base.execute 靠 AbortError 区分取消和连接
      // 超时，吞成 503 会让下游带着已 abort 的 signal 再打一次上游。
      if (error?.name === "AbortError") throw error;
      // 其余（wreq 不可用 / 真传输失败）回可重试的 503 synthetic，和 sidecar 路径
      // 同一个契约：fetchUpstream 永远回 Response，不抛给 base.execute。
      warnTransport(log, `TLS fallback failed (${error?.message || error}); answering a retryable 503`);
      return syntheticTransportError(`OpenCode free lane: TLS fallback failed (${error?.message || error}).`);
    }
  }

  async fetchUpstream(url, options, proxyOptions = null, log = null) {
    const response = await fetchViaTransport(url, options, proxyOptions, log);
    if (response) return response;
    if (OPENCODE_TRANSPORT_CONFIG.mode === "off") {
      // off 只是「不要 sidecar」，不等于「不要 TLS 兜底」：两个开关各管一件事。
      // 少了这一层，设置 off 的人会以为只是绕开 sidecar，实际 free lane 直接回到
      // undici 的假 429，而 OPENCODE_TLS_FALLBACK=on 看起来毫无作用。
      const offConfiguredProxy = resolveEffectiveProxyUrl(url, proxyOptions).url;
      if (!offConfiguredProxy && TLS_FALLBACK_ENABLED) {
        return this.fetchViaTlsFallback(url, options, proxyOptions, log);
      }
      return proxyAwareFetch(url, options, proxyOptions);
    }
    // 结构性不支持（socks5 等 Bun 无法承载的出口）与"sidecar 暂时不可用"是
    // 两件事：前者重试一万次也是同一个结果，必须快速失败且不带 retry-after，
    // 否则每条请求都要等一次 19s 超时 + 一次重启。
    const configuredProxy = resolveEffectiveProxyUrl(url, proxyOptions).url;
    if (configuredProxy && !/^https?:\/\//i.test(configuredProxy)) {
      const scheme = configuredProxy.split(":")[0];
      warnTransport(log, `${scheme} 出口不受 Bun 传输支持；请改用 http(s) 代理或设置 OPENCODE_TRANSPORT=off`);
      return new Response(JSON.stringify({
        type: "error",
        error: {
          type: "UpstreamTransportError",
          message: `OpenCode lane does not support ${scheme} proxies; use an http(s) proxy or OPENCODE_TRANSPORT=off.`,
        },
      }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-transport-error-type": "unsupported-proxy",
        },
      });
    }
    // Never downgrade to Node undici here. OpenCode fingerprints the client TLS/HTTP
    // stack: Bun (the sidecar) is served, while Node/undici is answered with a
    // quota-shaped 429 that is not a real quota. A silent downgrade therefore
    // burns egress health and sessions. Fail retryably so the caller can wait
    // for ASIP to rotate the IP.
    // 上游 ce060c79：undici 的 OpenSSL ClientHello 会被拒成 quota 形状的 429，
    // 但 wreq-js 送同一份 cipher 列表能过。所以 sidecar 不可用、又没有配代理时，
    // 这里退到它（要 OPENCODE_TLS_FALLBACK=on 才开）；没装 wreq-js 就回可重试的 503。
    // 代理判据只认 configuredProxy（= 连接代理 || 环境变量代理，NO_PROXY 已经算过），
    // 不自己再读一遍 process.env —— 那会在 NO_PROXY 放行时把能直连的路挡掉。
    if (!configuredProxy && TLS_FALLBACK_ENABLED) {
      return this.fetchViaTlsFallback(url, options, proxyOptions, log);
    }
    // 具体原因由 transport 侧写在这次调用自己的 options 上：60s 连接超时、上游无首字节、
    // sidecar 启动失败是三种完全不同的故障，之前都报同一句 "sidecar unavailable"。
    // 不读模块级变量：那种单值在并发下是别人的失败。
    const transportFailure = options.transportFailure || "unknown";
    warnTransport(log, `Bun transport unavailable for ${url} (${transportFailure}); refusing Node fallback`);
    return syntheticTransportError(
      `OpenCode free lane requires the Bun transport; sidecar unavailable (${transportFailure}).`,
      transportFailure,
    );
  }

  // Free tier moved from /zen/v1 to /inference/v1 (OpenCode v2); /zen/v1 now
  // answers every free request with 403 FreeTierError.
  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/inference/v1/responses`;
    if (isMessagesModel(model)) return `${base}/inference/v1/messages`;
    return `${base}/inference/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Mirrors the v2 CLI. Upstream needs x-opencode-session-id next to
    // x-opencode-session, and rejects any x-opencode-request (v1 only) with 403.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    // v2 CLI project/trace headers (local addition, kept across the port).
    applyOpencodeTransportHeaders(headers, { rawHeaders: raw, identity: session });
    return headers;
  }
}
