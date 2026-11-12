import { AntigravityExecutor } from "./antigravity.js";
import { AzureExecutor } from "./azure.js";
import { BedrockExecutor } from "./bedrock.js";
import { GeminiCLIExecutor } from "./gemini-cli.js";
import { GithubExecutor } from "./github.js";
import { IFlowExecutor } from "./iflow.js";
import { QoderExecutor } from "./qoder.js";
import { KiroExecutor } from "./kiro.js";
import { KimchiExecutor } from "./kimchi.js";
import { CodexExecutor } from "./codex.js";
import { CursorExecutor } from "./cursor.js";
import { VertexExecutor } from "./vertex.js";
import { OpenCodeExecutor } from "./opencode.js";
import { OpenCodeGoExecutor } from "./opencode-go.js";
import { OpenCodeZenExecutor } from "./opencode-zen.js";
import { GrokWebExecutor } from "./grok-web.js";
import { GrokCliExecutor } from "./grok-cli.js";
import { PerplexityWebExecutor } from "./perplexity-web.js";
import { DeepSeekWebExecutor } from "./deepseek-web.js";
import { GeminiWebExecutor } from "./gemini-web.js";
import { MuseWebExecutor } from "./muse-web.js";
import { VeoAiFreeWebExecutor } from "./veoaifree-web.js";
import { UcWebExecutor } from "./uc-web.js";
import { ChatGptWebExecutor } from "./chatgpt-web.js";
import { OllamaLocalExecutor } from "./ollama-local.js";
import { CommandCodeExecutor } from "./commandcode.js";
import { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan.js";
import { XiaomiMimoExecutor } from "./xiaomi-mimo.js";
import { MimoFreeExecutor } from "./mimo-free.js";
import { CodeBuddyExecutor } from "./codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
import TraeExecutor from "./trae.js";
import ZedExecutor from "./zed.js";
import WindsurfExecutor from "./windsurf.js";
import { DefaultExecutor } from "./default.js";
import { PROVIDERS } from "../config/providers.js";
import { MinimaxCodeExecutor } from "./minimax-code.js";
import { DevinCliExecutor } from "./devin-cli.js";

const executors = {
  antigravity: new AntigravityExecutor(),
  azure: new AzureExecutor(),
  "gemini-cli": new GeminiCLIExecutor(),
  github: new GithubExecutor(),
  iflow: new IFlowExecutor(),
  qoder: new QoderExecutor(),
  "qoder-cn": new QoderExecutor("qoder-cn"),
  kiro: new KiroExecutor(),
  kimchi: new KimchiExecutor(),
  codex: new CodexExecutor(),
  cursor: new CursorExecutor(),
  cu: new CursorExecutor(), // Alias for cursor
  vertex: new VertexExecutor("vertex"),
  "vertex-partner": new VertexExecutor("vertex-partner"),
  opencode: new OpenCodeExecutor(),
  "opencode-go": new OpenCodeGoExecutor(),
  "opencode-zen": new OpenCodeZenExecutor(),
  "grok-web": new GrokWebExecutor(),
  "grok-cli": new GrokCliExecutor(),
  gcli: new GrokCliExecutor(), // Alias
  gb: new GrokCliExecutor(), // Alias (Grok Build)
  "perplexity-web": new PerplexityWebExecutor(),
  "deepseek-web": new DeepSeekWebExecutor(),
  "gemini-web": new GeminiWebExecutor(),
  "muse-web": new MuseWebExecutor(),
  "veoaifree-web": new VeoAiFreeWebExecutor(),
  "veo-free": new VeoAiFreeWebExecutor(), // Alias
  "uc-web": new UcWebExecutor(),
  "chatgpt-web": new ChatGptWebExecutor(),
  "ollama-local": new OllamaLocalExecutor(),
  commandcode: new CommandCodeExecutor(),
  "xiaomi-tokenplan": new XiaomiTokenplanExecutor(),
  "xiaomi-mimo": new XiaomiMimoExecutor(),
  "mimo-free": new MimoFreeExecutor(),
  mmf: new MimoFreeExecutor(), // Alias for mimo-free
  "codebuddy-cn": new CodeBuddyExecutor(),
  "codebuddy-intl": new CodeBuddyIntlExecutor(),
  trae: new TraeExecutor(),
  zed: new ZedExecutor(),
  windsurf: new WindsurfExecutor(),
  "minimax-code": new MinimaxCodeExecutor("minimax-code"),
  "minimax-code-global": new MinimaxCodeExecutor("minimax-code-global"),
  "devin-cli": new DevinCliExecutor(),
  bedrock: new BedrockExecutor(),
  br: new BedrockExecutor(), // Alias for bedrock
  // Second Bedrock entry for xAI's Grok, which speaks OpenAI Chat Completions rather than the
  // Anthropic Messages format. Same executor, different registry transport format — the pattern
  // vertex / vertex-partner already uses.
  "bedrock-xai": new BedrockExecutor("bedrock-xai"),
  brx: new BedrockExecutor("bedrock-xai"), // Alias for bedrock-xai
};

const defaultCache = new Map();

// ── 未知 provider 的兜底策略 ──────────────────────────────────
// WHY：getExecutor 过去对任意字符串都兜底到 DefaultExecutor，而 DefaultExecutor
// 在 id 没有配置时会借用 PROVIDERS.openai（default.js:95 的 `|| PROVIDERS.openai`）。
// 于是一个拼写变体（opencode_zen / "opencode-zen " / OpenCode-Zen）不报错、不告警，
// 带着 opencode 的凭据直接打到 api.openai.com，同时绕过了 OpenCodeExecutor 的客户端
// 指纹加固。失败形态完全静默，只能靠比对出网流量发现。
//
// 三种 id 形态**合法地**没有专用执行器，必须放行：
//   1. 自带 transport 配置的 provider（openai / anthropic / gemini）
//   2. compat 家族（openai-compatible-* / anthropic-compatible-*）：真实 baseUrl
//      来自 credentials（base.js buildUrl），借来的 openai 配置只是模板
//   3. 注册表别名（cu / gcli / gb / mmf / br / brx …）—— 它们本来就在 executors 里
// 其余一律拒绝。EXECUTOR_UNKNOWN_PROVIDER=warn 可退回旧的静默兜底（应急开关）。
const COMPAT_PREFIXES = ["openai-compatible-", "anthropic-compatible-"];

function _unknownPolicy() {
  return String(process.env.EXECUTOR_UNKNOWN_PROVIDER || "error").toLowerCase();
}

export function getExecutor(provider, options = {}) {
  const raw = typeof provider === "string" ? provider : String(provider ?? "");
  const key = raw.trim();
  const lowered = key.toLowerCase();

  if (executors[key]) return executors[key];
  if (executors[lowered]) return executors[lowered]; // 容忍大小写/首尾空格

  // options.allowUnknown：调用方自己负责传输、只借用 DefaultExecutor 的
  // noAuth / refreshCredentials（图片生成就是这种：真正的 URL/headers 由
  // imageProviders/* 的 adapter 构建，provider id 从不在 PROVIDERS 里）。
  // 这条路径不算拼写错误，不该按未知 provider 处理。
  if (options.allowUnknown !== true) {
    const compat = COMPAT_PREFIXES.some((p) => lowered.startsWith(p));
    if (!compat && !PROVIDERS[key] && !PROVIDERS[lowered]) {
      const msg = `[executor] unknown provider ${JSON.stringify(raw)}: `
        + `no specialized executor and no transport config; refusing to fall back `
        + `to the openai template (EXECUTOR_UNKNOWN_PROVIDER=warn restores the old `
        + `silent fallback)`;
      if (_unknownPolicy() !== "warn") throw new Error(msg);
      console.warn(msg);
    }
  }

  if (!defaultCache.has(raw)) defaultCache.set(raw, new DefaultExecutor(raw));
  return defaultCache.get(raw);
}

export function hasSpecializedExecutor(provider) {
  const key = typeof provider === "string" ? provider.trim() : provider;
  return !!(executors[key] || executors[String(key).toLowerCase()]);
}

export { BaseExecutor } from "./base.js";
export { AntigravityExecutor } from "./antigravity.js";
export { AzureExecutor } from "./azure.js";
export { BedrockExecutor } from "./bedrock.js";
export { GeminiCLIExecutor } from "./gemini-cli.js";
export { GithubExecutor } from "./github.js";
export { IFlowExecutor } from "./iflow.js";
export { QoderExecutor } from "./qoder.js";
export { KiroExecutor } from "./kiro.js";
export { KimchiExecutor } from "./kimchi.js";
export { CodexExecutor } from "./codex.js";
export { CursorExecutor } from "./cursor.js";
export { VertexExecutor } from "./vertex.js";
export { DefaultExecutor } from "./default.js";
export { OpenCodeExecutor } from "./opencode.js";
export { OpenCodeGoExecutor } from "./opencode-go.js";
export { OpenCodeZenExecutor } from "./opencode-zen.js";
export { GrokWebExecutor } from "./grok-web.js";
export { GrokCliExecutor } from "./grok-cli.js";
export { PerplexityWebExecutor } from "./perplexity-web.js";
export { DeepSeekWebExecutor } from "./deepseek-web.js";
export { GeminiWebExecutor } from "./gemini-web.js";
export { MuseWebExecutor } from "./muse-web.js";
export { ChatGptWebExecutor } from "./chatgpt-web.js";
export { OllamaLocalExecutor } from "./ollama-local.js";
export { CommandCodeExecutor } from "./commandcode.js";
export { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan.js";
export { XiaomiMimoExecutor } from "./xiaomi-mimo.js";
export { MimoFreeExecutor } from "./mimo-free.js";
export { CodeBuddyExecutor } from "./codebuddy-cn.js";
export { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
export { default as TraeExecutor } from "./trae.js";
export { default as ZedExecutor } from "./zed.js";
export { default as WindsurfExecutor } from "./windsurf.js";
export { DevinCliExecutor } from "./devin-cli.js";
