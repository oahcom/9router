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
import { fetchViaTransport } from "../utils/opencodeTransport.js";
import { opencodeTlsFetch } from "../services/opencodeTlsClient.js";
import { normalizeString, resolveEffectiveProxyUrl } from "../utils/proxyResolution.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { rotateEgress } from "../utils/asipRotate.js";
import { classifyRotateReason } from "../utils/egressClassify.js";

// 同一出口的「没有备选」每分钟最多落一行；被压掉的次数在下一行末尾追报。
const NO_ALTERNATE_LOG_INTERVAL_MS = 60_000;
const noAlternateLogState = new Map();

function logNoAlternateEgress(log, egress, configured, now = Date.now()) {
  const key = egress?.id || "unknown";
  const state = noAlternateLogState.get(key) || { at: 0, suppressed: 0 };
  if (now - state.at < NO_ALTERNATE_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    noAlternateLogState.set(key, state);
    return;
  }
  const suffix = state.suppressed > 0 ? ` (+${state.suppressed} suppressed)` : "";
  if (!noAlternateLogState.has(key) && noAlternateLogState.size >= 64) {
    noAlternateLogState.delete(noAlternateLogState.keys().next().value);
  }
  noAlternateLogState.set(key, { at: now, suppressed: 0 });
  log?.warn?.(
    "EGRESS",
    `${describeEgress(egress)} 429, no alternate egress (${configured} configured, all excluded as this url or cooling)${suffix}`
  );
}
import {
  resolveEgress,
  markEgressCooling,
  getEgressCooldown,
  hasActiveDirectCooldown,
  hasAlternateEgresses,
  selectAlternateProxy,
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

function syntheticTransportError(message, { retryable = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (retryable) headers["retry-after"] = "1";
  headers["x-transport-error-type"] = "synthetic";
  return new Response(JSON.stringify({
    type: "error",
    error: { type: "UpstreamTransportError", message },
  }), { status: 503, headers });
}

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

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
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
  // Otherwise we answer a retryable 503. 配了代理（含 vercel relay）时这条兜底不
  // 参与：proxyAwareFetch 会先走代理/relay，那是调用方明确选的路。
  async execute(args) {
    const { model, stream, credentials, log } = args;
    let proxyOptions = args.proxyOptions || null;

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
      const selection = selectAlternateProxy(proxyOptions, targetUrl, new Set([egress.id]));
      if (selection.alternate) {
        log?.debug?.(
          "EGRESS",
          `${describeEgress(egress)} cooling ${Math.ceil(cooldown.retryAfterMs / 1000)}s → ${describeEgress(selection.alternate.egress)}`
        );
        proxyOptions = selection.alternate.proxyOptions;
        egress = selection.alternate.egress;
      } else {
        // 本地拒绝之前先换一次出口。9router 的两个 proxy pool 内容完全相同
        // （都指向 127.0.0.1:7890），selectAlternateProxy 永远返回 null，这里
        // 一旦拒绝就是「回带 retry-after 数十小时」的死锁 —— 后续请求全被本地
        // 拦掉，根本走不到下面 429 重试分支。实测这就是服务不可用的直接原因。
        const rotated = await rotateEgress("rate429");
        // 判据不能只看 switched：no_warm_standby / too_frequent 时 asip 没换线，
        // 但冷却已经过期、请求本来也发不出去，重试一次成本极低，而放弃必然 429。
        // 唯一不该重试的是接口不可用（asip 没在跑），那种情况重试也是白重试。
        const rotateHappened = rotated.reason !== "unavailable";
        if (rotateHappened) {
          clearProxyDispatchers();
          resetEgressState();
          log?.warn?.(
            "EGRESS",
            "asip rotated (" + rotated.reason + ") before local 429 -> retry on fresh egress"
          );
          const retryPrepared = this.prepareRequestCredentials({ ...args, egressId: "asip-rotated" });
          const retried = await super.execute({
            ...args,
            credentials: retryPrepared,
            proxyOptions,
          });
          if (retried?.response && retried.response.status !== 429) return retried;
        }
        // upstream 的 retry-after 可能是数万秒（实测见过 34842s = 9.7 小时）。
        // 原样透传等于一次 429 就把服务锁死大半天，这才是服务不可用的直接原因。
        // 封顶 60s：宁可让调用方多试几次，也不要静默挂死。
        const retryAfterMs = Math.min(
          cooldown.retryAfterMs,
          selection.earliestCooldownMs ?? Infinity,
          MAX_LOCAL_COOLDOWN_MS
        );
        log?.warn?.(
          "EGRESS",
          `${describeEgress(egress)} cooling ${Math.ceil(retryAfterMs / 1000)}s; no alternate — local 429`
        );
        return {
          response: syntheticRateLimitResponse(retryAfterMs),
          url: targetUrl,
          headers: {},
          transformedBody: args.body,
        };
      }
    }

    const prepared = this.prepareRequestCredentials({ ...args, egressId: egress.id });
    const requestStartedAt = Date.now();
    const retryBody = hasAlternateEgresses(proxyOptions) ? cloneRequestBody(args.body) : null;

    let result = await super.execute({ ...args, credentials: prepared, proxyOptions });

    // 传输层悬挂（出口隧道中途重连 → 无首字节 → 上层超时合成为 503）时，
    // 换另一条出口透明重试一次。与 429 路径不同，这里**不标记任何冷却**：
    // 503 不是出口限流/信誉证据，标记会误烧正常 IP（INC-008/INC-009）。
    if (result?.response?.status === 503 && retryBody) {
      const synthetic = result.response.headers.get("x-transport-error-type") === "synthetic";
      const failureText = synthetic ? "UpstreamTransportError" : await readResponsePrefixText(result.response.clone());
      if (/UpstreamTransportError/.test(failureText)) {
        const failover = selectAlternateProxy(proxyOptions, targetUrl, new Set([egress.id]));
        if (failover.alternate) {
          const failoverCredentials = this.prepareRequestCredentials({
            ...args,
            body: retryBody,
            egressId: failover.alternate.egress.id,
          });
          log?.warn?.(
            "EGRESS",
            `transport failure on ${describeEgress(egress)} → retry once on ${describeEgress(failover.alternate.egress)}`
          );
          result = await super.execute({
            ...args,
            body: retryBody,
            credentials: failoverCredentials,
            proxyOptions: failover.alternate.proxyOptions,
          });
        }
      }
    }
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

    // asip sync rotate: 9router 的两个 proxy pool 内容完全相同（都指向 127.0.0.1:7890），
    // selectAlternateProxy 换不出任何东西，这里的 429 只能靠 asip 切 sing-box 选择器解决。
    // 切完必须丢掉复用连接，否则重试走的还是旧隧道。
    if (retryBody || typeof args.body === "string") {
      const asip = await rotateEgress(rotateReason);
      if (asip.switchedAt >= requestStartedAt) {
        clearProxyDispatchers();
        log?.warn?.("EGRESS", "asip rotated egress (" + asip.reason + ") -> retry once on fresh connection");
        const rotatedResult = await super.execute({
          ...args,
          credentials: prepared,
          proxyOptions,
          ...(retryBody ? { body: retryBody } : {}),
        });
        if (rotatedResult?.response
            && rotatedResult.response.status !== 429
            && !(upstreamStatus === 403 && rotatedResult.response.status === 403)) {
          return rotatedResult;
        }
        result = rotatedResult ?? result;
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

    const selection = selectAlternateProxy(proxyOptions, targetUrl, new Set([egress.id]));
    const retrySameEgress = rotated && egress.kind === "direct";

    if (!selection.alternate && !retrySameEgress) {
      const cooling = markEgressCooling(egress, retryAfterMs);
      if (cooling) {
        log?.warn?.(
          "EGRESS",
          `${describeEgress(egress)} cooling ${Math.ceil(cooling.retryAfterMs / 1000)}s (429, retry-after ${result.response.headers?.get?.("retry-after") ?? "none"})`
        );
      } else {
        // Fixed proxy egresses are never cooled (the sing-box selector is swapped
        // out-of-band by the rotation manager, so a URL-keyed cooldown can outlive
        // the exit it was recorded against), so the branch above stays silent for
        // them and the whole switch path logs nothing. That makes "no alternate
        // exists" read exactly like "switched and failed". Name the condition, but
        // throttle it: while WARP quota is exhausted every request is a 429 and the
        // first version of this line produced 585 identical entries in 39 minutes.
        const configured = Array.isArray(proxyOptions?.connectionProxyAlternates)
          ? proxyOptions.connectionProxyAlternates.length
          : 0;
        logNoAlternateEgress(log, egress, configured);
      }
      return result;
    }

    if (selection.alternate) {
      const cooling = markEgressCooling(egress, retryAfterMs);
      if (cooling) {
        log?.warn?.(
          "EGRESS",
          `${describeEgress(egress)} cooling ${Math.ceil(cooling.retryAfterMs / 1000)}s (429, retry-after ${result.response.headers?.get?.("retry-after") ?? "none"})`
        );
      }
    }

    const retryEgress = retrySameEgress ? egress : (selection.alternate?.egress || egress);
    const retryProxyOptions = retrySameEgress ? proxyOptions : (selection.alternate?.proxyOptions ?? proxyOptions);
    const retryCredentials = this.prepareRequestCredentials({
      ...args,
      body: retryBody || args.body,
      egressId: retryEgress.id,
    });

    log?.warn?.(
      "EGRESS",
      `429 on ${describeEgress(egress)} → retry once on ${describeEgress(retryEgress)}`
    );

    const retryResult = await super.execute({
      ...args,
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

  async fetchUpstream(url, options, proxyOptions = null) {
    const response = await fetchViaTransport(url, options, proxyOptions);
    if (response) return response;
    if (OPENCODE_TRANSPORT_CONFIG.mode === "off") {
      return proxyAwareFetch(url, options, proxyOptions);
    }
    // 结构性不支持（socks5 等 Bun 无法承载的出口）与"sidecar 暂时不可用"是
    // 两件事：前者重试一万次也是同一个结果，必须快速失败且不带 retry-after，
    // 否则每条请求都要等一次 19s 超时 + 一次重启。
    const configuredProxy = resolveEffectiveProxyUrl(url, proxyOptions).url;
    if (configuredProxy && !/^https?:\/\//i.test(configuredProxy)) {
      const scheme = configuredProxy.split(":")[0];
      console.warn(`[OpenCode] ${scheme} 出口不受 Bun 传输支持；请改用 http(s) 代理或设置 OPENCODE_TRANSPORT=off`);
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
      // wreq 的 timeout 是整请求超时（含正文），而 sidecar 只卡响应头。流式请求
      // 一旦超过它会在流中间被 abort，所以只在非流式请求上传这个上限。
      const streamingRequest = (() => {
        try {
          return JSON.parse(options.body || "{}").stream === true;
        } catch {
          return false;
        }
      })();
      try {
        return await proxyAwareFetch(url, {
          ...options,
          directFetch: (target, init) =>
            opencodeTlsFetch(
              target,
              { method: init.method, headers: init.headers, body: init.body },
              {
                signal: init.signal,
                timeoutMs: streamingRequest ? undefined : OPENCODE_TRANSPORT_CONFIG.tlsTimeoutMs,
              },
            ),
        }, proxyOptions);
      } catch (error) {
        // 客户端自己断了要原样往上抛：base.execute 靠 AbortError 区分取消和
        // 连接超时，吞成 503 会让下游带着已 abort 的 signal 再打一次上游。
        if (error?.name === "AbortError") throw error;
        // 其余（wreq 不可用 / 真传输失败）回可重试的 503 synthetic，和 sidecar
        // 路径同一个契约：fetchUpstream 永远回 Response，不抛给 base.execute。
        console.warn("[OpenCode] TLS fallback failed (" + error.message + "); answering a retryable 503");
        return syntheticTransportError("OpenCode free lane: TLS fallback failed; sidecar unavailable.");
      }
    }
    console.warn(`[OpenCode] Bun transport unavailable for ${url}; refusing Node fallback`);
    return new Response(JSON.stringify({
      type: "error",
      error: {
        type: "UpstreamTransportError",
        message: "OpenCode free lane requires the Bun transport; sidecar unavailable.",
      },
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": "1",
        "x-transport-error-type": "synthetic",
      },
    });
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
