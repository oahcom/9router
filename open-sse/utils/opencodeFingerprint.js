/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * Two body-side gates are mirrored here (live probes 2026-10-26, /inference/v1):
 *
 * - Tools: free-tier requests must declare OpenCode's own `read` and `shell`
 *   tools with their exact descriptions and parameter schemas; stubbed
 *   descriptions, renamed schemas or tool_choice "none" are answered with 403
 *   FreeTierError. Caller tools are sent untouched. A tool that already uses an
 *   exact fingerprint name with a different definition adopts OpenCode's
 *   definition in place whenever its arguments can carry them; only a genuinely
 *   different schema travels under an alias, and the response side restores
 *   that caller's original name.
 * - System prompt: the CLI's `<env>` marker must be present. A request missing
 *   either half (marker or tools) answers 429 FreeUsageLimitError regardless of
 *   headers, UA or session shape; both halves together pass.
 *
 * Transport is a third gate and lives in services/opencodeTlsClient.js.
 *
 * 第四道门（2026-10-29 追加）：caller 工具名本身也会被判 429，
 * 见 neutralizeCallerToolNames()。
 */
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";

/** Names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

// Verbatim from the OpenCode v2.0.26 CLI. Upstream compares description and
// parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

// Request body -> names renamed for that request. transformRequest() mutates the
// same body object that chatCore passed into the executor, so a WeakMap keeps the
// mapping request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

// 真名 -> 别名，**跨 body 共享**。
//
// WHY 需要它：WeakMap 按对象引用记账，而请求体在若干处会被克隆
// （base.js 的 structuredClone、executor 的 asip 轮换重试、429 后的重放）。
// 克隆换了引用 → WeakMap 取不到 → 幂等保护失效 → 别名套别名
// （Bash → fn_18vix4v → fn_1ciz1x0）。上游回的是第二层别名，单跳还原只回得到
// 第一层的 fn_18vix4v，客户端从未声明过这个名字 → "No such tool available"。
//
// 实测 2026-11-11：本机 asip 轮换重试路径上稳定复现，第二层别名 fn_1ciz1x0
// 就是客户端报「不存在」的那个名字。
//
// **方向必须是「真名 -> 别名」**：判定「这个名字是不是我们生成的别名」时，
// 要问的是「有没有哪个真名映射到了它」。反过来记（别名 -> 真名）会误判：
// caller 声明的工具名恰好叫 `shell_client`（与指纹别名同名）时，会被当成
// 「已别名化」而放行 —— 实测既有测试 `neutralizes plugin tool names instead
// of reusing client alias names` 就是钉这个的。
//
// 别名按名字哈希生成（同一真名恒得同一别名），所以这张表跨请求一致，
// 不会把两个不同的真名映到同一别名。
const aliasRegistry = new Map();
// 反向表：别名 -> 真名。与 aliasRegistry 同增同删，只为 O(1) 反查。
const aliasReverse = new Map();

/**
 * 反向查表：这个**名字**是不是我们为某个真名生成过的别名？是则返回那个真名。
 *
 * WHY 要反向查（而不是直接 aliasRegistry.get(name)）：登记表是「真名 -> 别名」，
 * 正向查问的是「这个真名有没有被改过名」，而判定克隆体需要问的是
 * 「这个**名字**是不是别名」。caller 声明的工具名恰好叫 `shell_client` 时，
 * 正向查会误判成「已别名化」而放行 —— 实测既有测试
 * `neutralizes plugin tool names instead of reusing client alias names`
 * 钉的就是这个。
 */
function aliasFor(name) {
  if (!name) return null;
  return aliasReverse.get(name) || null;
}

/** 登记一次改名：真名 -> 别名，同时补反向表。 */
function registerAlias(original, alias) {
  aliasRegistry.set(original, alias);
  aliasReverse.set(alias, original);
}

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return !!def && def.description === want.description
    && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * True when `tool` already speaks OpenCode's parameter names for `key`, so the
 * fingerprint definition can replace its own without hiding or adding an
 * argument the caller's handler expects.
 *
 * This is the common case, not an edge: OpenCode composes `shell`'s description
 * from `process.platform`, so the very same tool run on Windows reports
 * "Commands run on Windows using pwsh." while the captured definition says
 * "Commands run on Linux using bash." — a two-word difference that an exact
 * string compare rejects.
 */
function canNormalizeInPlace(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const props = def?.parameters?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;

  const wanted = Object.keys(FINGERPRINT_TOOL_DEFINITIONS[key].parameters.properties || {});
  const declared = Object.keys(props);
  if (declared.some((name) => !wanted.includes(name))) return false;
  return FINGERPRINT_TOOL_DEFINITIONS[key].parameters.required.every((name) => declared.includes(name));
}

/**
 * Replace `tool`'s definition with OpenCode's while keeping its name, so the
 * wire carries a single, gate-satisfying tool instead of a caller tool plus a
 * placeholder of the same purpose.
 */
function withFingerprintDefinition(tool, key) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[key];
  const fn = chatFunctionOf(tool);
  return fn
    ? { ...tool, function: { ...fn, description, parameters } }
    : { ...tool, description, parameters };
}

/**
 * Keep caller tools on the fingerprint names whenever their arguments can carry
 * OpenCode's, and move the remaining ones off them so the exact definitions can
 * be appended without a duplicate name. Everything else, including case
 * variants such as `Read`, is preserved verbatim; upstream accepts them
 * alongside `read`.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      // 指纹别名（<key>_client）不进登记表，所以这里不做「已别名化」复用：
      // 它要么是 caller 的真名（照常处理），要么是中性别名（由
      // neutralizeCallerToolNames 复用）。指纹别名自身在克隆体上由
      // concealFingerprintToolNames 重新生成 —— 名字稳定（`<key>_client`
      // / `<key>_client2`），不会套出第三层。
      out.push(tool);
      continue;
    }

    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFingerprintDefinition(tool, key)) {
      out.push(tool);
      continue;
    }

    // Same tool, different wording. Adopt OpenCode's definition in place: the
    // caller keeps its own name, so there is no alias to restore, no alias name
    // for the model to collide with, and no placeholder to explain away.
    if (canNormalizeInPlace(tool, key)) {
      out.push(withFingerprintDefinition(tool, key));
      continue;
    }

    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    // **不进别名登记表**：指纹别名对应的是指纹工具（shell/read），不是 caller
    // 的真名。登记它会让 caller 恰好声明了 `shell_client` 的工具被误判成
    // 「已别名化」而原样放行 —— 那正是 caller 的真名，必须照常中性化。
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/**
 * Free lane 的第二道「名字门」（实测 2026-10-29，非推断）：
 *
 * - 单个 `subagent_fork` 就触发 429 FreeUsageLimitError —— 大小写不敏感
 *   （`subagent_Fork` 同样 429），且与工具定义无关：把它的定义换成 `subagent`
 *   的照样 429，反过来 `subagent_zzz` 挂着 fork 的定义却 200。
 * - 名字集合层面还有阈值：48 个 caller 工具里真名占 46 个即 429，45 个通过；
 *   逐个单测时每个名字又都通过。
 * - 决定性对照：同一份 50 工具报文（定义一字未改）只把 48 个 caller 名换成
 *   中性名，连续 4 次全部 200；换回真名立刻 429。
 *
 * 因此把非指纹工具统一改成稳定的中性别名，响应侧交给现成的
 * restoreToolNames() 还原。别名按名字哈希生成：跨轮次稳定，不吃 prefix cache。
 * 开关：OPENCODE_NEUTRALIZE_TOOL_NAMES=off 可关掉。
 */
const NEUTRALIZE_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.OPENCODE_NEUTRALIZE_TOOL_NAMES ?? "on").toLowerCase(),
);

/** 稳定的中性别名：同一个名字永远得到同一个别名，与工具数组顺序无关。 */
function neutralToolAlias(name, taken) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const base = `fn_${h.toString(36).padStart(7, "0")}`;
  let alias = base;
  for (let i = 2; taken.has(alias); i++) alias = `${base}${i}`;
  return alias;
}

/**
 * Rename every caller tool that is not a fingerprint tool to a neutral alias.
 * `skip` holds names already renamed by concealFingerprintToolNames() so they
 * are not aliased twice (the restore map is single-hop).
 *
 * @param {Array} tools
 * @param {Map<string,string>} map  sent name -> original name
 * @param {Set<string>} skip
 * @returns {Array}
 */
export function neutralizeCallerToolNames(tools, map, skip = new Set()) {
  if (!NEUTRALIZE_ENABLED) return tools;
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  const taken = new Set(tools.map(toolNameOf).filter(Boolean));
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    const name = toolNameOf(tool);
    if (!name || fingerprintToolKey(name) || skip.has(name)) return tool;
    // **这个名字是我们为某个真名生成过的别名**（克隆体的情形）。克隆换了
    // 引用，WeakMap 的幂等保护失效，但内容还记得：直接复用别名，绝不套
    // 第二层。套第二层的后果是上游回 fn_1ciz1x0，单跳还原只回得到
    // fn_18vix4v —— 客户端从没声明过这个名字，于是 "No such tool available"。
    //
    // 判据是「这个**名字**是不是某个真名的别名」，不是「这个真名有没有被
    // 改过名」：caller 声明的工具名恰好叫 `shell_client` 时，它虽然长得
    // 像别名，但那是 caller 自己的真名，必须照常中性化。
    const known = aliasFor(name);
    if (known) {
      map.set(name, known);
      return tool;
    }
    const alias = neutralToolAlias(name, taken);
    taken.add(alias);
    registerAlias(name, alias);
    map.set(alias, name);
    return withToolName(tool, alias);
  });
}

/**
 * Declare OpenCode's definition for each fingerprint tool not already present.
 *
 * 补到 tools 数组**最前面**（2026-11-14）：上游 prompt 把 tools 块渲染在会话
 * 历史之前（受控实验 + 生产相关性证实），前缀缓存按字节匹配 —— 客户端工具表
 * 中途生长（实测 hermes 会话 TOOL 9→18）时，若 read/shell 接在客户端工具尾部，
 * 它们的定义会被新增工具顶出共享前缀；钉在头部则 [read][shell][旧工具] 在
 * 生长轮全部保住，客户端新工具永远追加在旧工具之后。上游若自行按名排序则
 * 两种排法渲染结果相同（无害）。
 *
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  const missing = [];
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    missing.push(flat
      ? { type: "function", name, description, parameters, strict: false }
      : { type: "function", function: { name, description, parameters } });
    appended.push(name);
  }
  if (missing.length) tools.unshift(...missing);
  return appended;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);

  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

/**
 * Rename prior-turn calls to concealed caller tools as well; otherwise the model
 * reads its own earlier calls as calls to OpenCode's tool of the same name.
 */
export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item);
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) =>
          aliases.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
            : call),
      };
    });
  }
}

// Without the old "must not be used" descriptions the model does call the
// appended tools (live probe: `read` on "what files are in /etc?"), so tell it
// in the system prompt instead. Upstream does not gate on the prompt text.
// Wording matters: "not available" made the model also refuse the caller's own
// Read/Bash; "placeholders ... use the other tools" kept those working.
function noteUnavailableTools(body, flat, names, claude = false) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  // Claude-shaped bodies carry `system` instead; /messages rejects role:"system".
  if (claude || body.system !== undefined) {
    body.system = appendSystemText(body.system, note);
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

// The marker gate reads text only: a foreign system prompt plus this exact block
// passes, so the marker is appended to the caller's own prompt rather than
// replacing it. Values mirror a real CLI instance on this host.
const ENV_TAG = "<env>";
const ENV_HEADING = "Here is some useful information about the environment you are running in:";
const ENV_TMP_DIR = path.join(os.tmpdir(), "opencode");
// The gate only checks that the `<env>` marker exists — it never compares the
// path. process.cwd() put the gateway host's real directory into every upsteam
// prompt, and the model repeated it to end users ("I'm in
// /home/administrator/9router"), leaking the host layout. Keep it neutral.
// 路径生成（2026-11-14 改为会话稳定，见 envWorkdirFor）：base 只提供
// 「看起来像真实项目」的前缀 + 3 位后缀。INC-018（2026-11-10，固定值
// /home/administrator/.9router 被精确字符串拉黑）的防御保留 —— 跨会话多样，
// 但**同一会话内恒定**：逐请求随机曾让 <env> 块每发都变，上游前缀缓存在
// 系统提示词尾部就断掉，100K+ 会话历史每条请求全量重算 prefill（实测命中率
// 5-8%，而自带稳定 env 的透传客户端同一上游吃到 179K 缓存）。真实 CLI 会话
// 的 cwd 本来就跨轮次不变，逐请求变反而是破绽。需要钉死单值时用
// OPENCODE_ENV_WORKING_DIR。
const ENV_WORKDIR_BASES = [
  "/home/user/project",
  "/home/user/workspace",
  "/home/user/src",
  "/workspace/app",
  "/srv/app",
];
const ENV_RAND_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ENV_WORKDIR_PIN = process.env.OPENCODE_ENV_WORKING_DIR || "";

export function envWorkdir(now = Date.now()) {
  if (ENV_WORKDIR_PIN) return ENV_WORKDIR_PIN;
  const base = ENV_WORKDIR_BASES[randomInt(ENV_WORKDIR_BASES.length)];
  const width = 2 + randomInt(2);
  let suffix = "";
  for (let i = 0; i < width; i += 1) {
    suffix += ENV_RAND_ALPHABET[randomInt(ENV_RAND_ALPHABET.length)];
  }
  return `${base}-${suffix}`;
}

/**
 * 会话稳定推导：同一锚点永远得到同一路径，跨锚点仍多样（FNV-1a 混淆）。
 * 形状与随机版一致（base + 3 位后缀）。无锚点（探测/无消息体）回退随机。
 */
export function envWorkdirFor(conversationKey) {
  if (ENV_WORKDIR_PIN) return ENV_WORKDIR_PIN;
  if (!conversationKey) return envWorkdir();
  let h = 0x811c9dc5;
  for (let i = 0; i < conversationKey.length; i += 1) {
    h ^= conversationKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const base = ENV_WORKDIR_BASES[h % ENV_WORKDIR_BASES.length];
  let x = (h ^ 0x9e3779b9) >>> 0;
  let suffix = "";
  for (let i = 0; i < 3; i += 1) {
    suffix += ENV_RAND_ALPHABET[x % ENV_RAND_ALPHABET.length];
    x = (Math.imul(x ^ (x >>> 15), 0x2545f491) >>> 0) + 0x9e3779b9;
  }
  return `${base}-${suffix}`;
}

/**
 * 会话锚点：首条用户侧消息的前 512 字符。会话生长时它不变，于是同会话
 * 每条请求的 <env> 字节恒定、前缀缓存可命中整段历史；跨会话自然分散。
 */
function conversationAnchor(body) {
  try {
    const msgs = Array.isArray(body?.messages) ? body.messages
      : Array.isArray(body?.input) ? body.input
      : null;
    if (!msgs) return "";
    for (const m of msgs) {
      const role = m?.role ?? m?.type;
      if (role === "system" || role === "instructions"
          || role === "function_call_output") continue;
      const t = typeof m?.content === "string" ? m.content
        : typeof m?.text === "string" ? m.text
        : (m?.content != null ? JSON.stringify(m.content) : "");
      if (t) return t.slice(0, 512);
    }
    return "";
  } catch {
    return "";
  }
}

export function envFingerprintPrompt(now = Date.now(), conversationKey = null) {
  const wd = conversationKey != null
    ? envWorkdirFor(conversationKey)
    : envWorkdir(now);
  return [
    ENV_HEADING,
    ENV_TAG,
    `  Working directory: ${wd}`,
    `  Workspace root folder: ${wd}`,
    "  Is directory a git repo: no",
    `  Platform: ${process.platform}`,
    `  Prefer ${ENV_TMP_DIR} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n");
}

const ENV_WORKING_DIR = envWorkdir();
const ENV_FINGERPRINT_PROMPT = envFingerprintPrompt();

/** True when the marker is already present; a genuine opencode client is passthrough. */
function systemCarriesEnv(system) {
  if (typeof system === "string") return system.includes(ENV_TAG);
  if (Array.isArray(system)) {
    return system.some((block) => typeof block?.text === "string" && block.text.includes(ENV_TAG));
  }
  return false;
}

/** Append `text` to a system prompt held as a string, text blocks, or unset. */
function appendSystemText(system, text) {
  if (typeof system === "string") {
    return system.trim() ? `${system}\n\n${text}` : text;
  }
  const blocks = Array.isArray(system) ? [...system] : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (typeof block?.text === "string") {
      const existing = block.text.trim();
      blocks[i] = { ...block, text: existing ? `${block.text}\n\n${text}` : text };
      return blocks;
    }
  }
  return [...blocks, { type: "text", text }];
}

/**
 * Append the CLI's environment marker without replacing the caller's content,
 * covering all three request shapes: Responses (`instructions`), chat
 * (`messages[]` system) and claude-top-level (`system`). Fail-open — the marker
 * is an enhancement, so a surprising body is left untouched.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses instructions, false for chat/claude
 * @param {object} [options]
 * @param {boolean} [options.claude] - body posts to /messages (claude shape)
 * @returns {boolean} true when the marker was added
 */
export function applyEnvFingerprint(body, flat, { claude = false } = {}) {
  try {
    if (!body || typeof body !== "object") return false;
    // 会话锚点推导 env：同会话字节恒定（前缀缓存友好），跨会话多样（INC-018）。
    const prompt = envFingerprintPrompt(Date.now(), conversationAnchor(body));

    if (flat) {
      if (body.instructions !== undefined && typeof body.instructions !== "string") return false;
      if (systemCarriesEnv(body.instructions)) return false;
      body.instructions = (typeof body.instructions === "string" && body.instructions.trim())
        ? `${body.instructions}\n\n${prompt}`
        : prompt;
      return true;
    }

    if (claude || body.system !== undefined) {
      if (systemCarriesEnv(body.system)) return false;
      body.system = appendSystemText(body.system, prompt);
      return true;
    }

    if (!Array.isArray(body.messages)) return false;
    const idx = body.messages.findIndex((msg) => msg?.role === "system");
    if (idx >= 0) {
      const target = body.messages[idx];
      if (systemCarriesEnv(target.content)) return false;
      const content = appendSystemText(target.content, prompt);
      body.messages = body.messages.map((msg, i) => (i === idx ? { ...msg, content } : msg));
      return true;
    }
    body.messages = [{ role: "system", content: prompt }, ...body.messages];
    return true;
  } catch {
    return false;
  }
}

/**
 * Full request-side pass: normalize caller tools that collide with a
 * fingerprint name, append OpenCode's definitions for any that are missing, and
 * tell the model the appended ones are off-limits.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat, { claude = false } = {}) {
  if (!body || typeof body !== "object") return new Map();
  // The executor's retry / egress-failover branches call transformRequest again on
  // the same body object. Re-running the pass aliases the alias (get_file ->
  // fn_19omnbq -> fn_06c90ev) and overwrites the recorded map, so single-hop
  // restore returns the FIRST alias — a name the client never declared.
  const alreadyRenamed = renamedToolNames.get(body);
  if (alreadyRenamed?.size) return alreadyRenamed;

  // **克隆体的情形**：WeakMap 按引用记账，换了引用就取不到上一轮的 map。
  // 这时不能从头再改一遍名 —— 会把别名套成别名。判据是「这一层的工具名
  // 全部已是登记表里的别名」：那就说明名已经改过了，只把映射重建出来。
  const rebound = rebuildRenamedMap(body);
  if (rebound) return rebound;

  const { tools, map } = concealFingerprintToolNames(body.tools);
  const normalized = neutralizeCallerToolNames(Array.isArray(tools) ? tools : [], map, new Set(map.keys()));
  body.tools = Array.isArray(normalized) ? normalized : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailableTools(body, flat, appended, claude);

  // The `<env>` marker is required on every free-lane request, with or without tools.
  applyEnvFingerprint(body, flat, { claude });

  // Responses keeps its explicit auto default. Never default to "none": upstream
  // answers tool_choice "none" with 403 FreeTierError.
  if (!body.tool_choice && flat) body.tool_choice = "auto";

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

/**
 * 克隆体的 map 重建：这一层的工具名已经全是登记表里的别名时，把映射捡回来。
 *
 * WHY 需要：请求体在 base.js（structuredClone）、executor 的 asip 轮换重试、
 * 429 重放处都会被克隆。克隆换了对象引用 → WeakMap 取不到上一轮记下的 map →
 * 幂等保护失效 → 别名套别名（fn_18vix4v → fn_1ciz1x0）。上游回的是第二层，
 * 单跳还原只回得到第一层 fn_18vix4v，客户端从没声明过它 → "No such tool
 * available"。实测 2026-11-11，本机 asip 轮换路径上稳定复现。
 *
 * 判据：**至少有一个工具名在登记表里，且该名字本身就是别名形态**。
 * 只有真名（客户端原样声明的）不算 —— 那是首轮，还没改过名。
 *
 * @returns {Map<string,string>|null} 重建出的 map；不是克隆体时返回 null
 */
function rebuildRenamedMap(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) return null;
  const map = new Map();
  let aliased = 0;
  let plain = 0;
  for (const tool of tools) {
    const name = toolNameOf(tool);
    if (!name) continue;
    // 指纹工具（read/shell）本来就以真名留在报文里，不参与别名判定。
    if (fingerprintToolKey(name)) continue;
    const known = aliasFor(name);
    if (!known) {
      plain++;
      continue;
    }
    map.set(name, known);
    aliased++;
  }
  // 一个别名都没命中 → 不是「已改过名的克隆体」，按首轮处理。
  if (aliased === 0) return null;
  // 命中了但也混着未改名的真名 → 这是首轮（真名会被改），不能跳过改名。
  if (plain > 0) return null;
  recordRenamedToolNames(body, map);
  return map;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // SSE envelope `{event, data}`: formatSSE unwraps `data` and re-serialises it
  // as the frame body, so restoring only the outer object loses every rename.
  if (payload.data && typeof payload.data === "object") {
    const restoredData = restoreToolNames(payload.data, map);
    if (restoredData !== payload.data) put("data", restoredData);
  }

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // The terminal `response.completed` / `response.incomplete` event carries the
  // whole response object, so its output[] sits one level down. Missing this
  // handed codex the alias in the final event even when every delta was restored.
  if (payload.response && typeof payload.response === "object") {
    const restoredResponse = restoreToolNames(payload.response, map);
    if (restoredResponse !== payload.response) put("response", restoredResponse);
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
