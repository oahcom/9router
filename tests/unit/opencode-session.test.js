import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  // These tests exercise session resolution, so keep the Node path mocked.
  process.env.OPENCODE_TRANSPORT = "off";
  // Egress must resolve to direct for the same-egress 429 retry assertions.
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    delete process.env[key];
  }
  return { fetchMock: vi.fn() };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: vi.fn(async () => null),
  resetTransport: vi.fn(),
  bumpTransportGeneration: vi.fn(),
}));

import { getExecutor } from "../../open-sse/executors/index.js";
// 2026-10-30：caller 工具改中性别名（fn_<hash>）后，还原表是契约的一部分，
// 这里直接断言「客户端拿到的 tool_calls 还能变回真名」。
import { restoreToolNames, takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import {
  OPENCODE_SESSION_RE,
  generateSessionId,
  translateSessionId,
  stableSessionId,
} from "../../open-sse/executors/opencode.js";
import {
  generateSessionId as generateZenSessionId,
  translateSessionId as translateZenSessionId,
} from "../../open-sse/executors/opencode-zen.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  resetEgressState();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  // Upstream decodes the prefix as ~(time * 0x1000 + counter): it answers 403
  // FreeTierError for a large counter and 429 FreeUsageLimitError when the
  // decoded clock is far from the request time, so both fields must stay real.
  function counterOf(id) {
    return Number(~BigInt(`0x${id.slice(4, 16)}`) & 0xfffn);
  }

  function sessionClock(id) {
    const raw = ~BigInt(`0x${id.slice(4, 16)}`) & ((1n << 48n) - 1n);
    return Number(raw >> 12n);
  }

  it("encodes a small counter in session prefixes so the free-tier gate accepts them", () => {
    for (const translate of [translateSessionId, translateZenSessionId]) {
      for (const raw of ["claude:550e8400-e29b-41d4-a716-446655440000", "session-from-codex", "", "x".repeat(300)]) {
        const translated = translate(raw, "claude");
        expect(translated).toMatch(OPENCODE_SESSION_RE);
        expect(counterOf(translated)).toBeGreaterThanOrEqual(1);
        expect(counterOf(translated)).toBeLessThanOrEqual(16);
        expect(translate(raw, "claude")).toBe(translated);
      }
    }
    expect(counterOf(generateSessionId(1_700_000_000_000))).toBeLessThanOrEqual(16);
    expect(counterOf(generateZenSessionId(1_700_000_000_000))).toBe(1);
  });

  it("stamps translated sessions with the current clock", () => {
    const now = Date.now() % 2 ** 36;
    for (const raw of ["clock-hint-a", "clock-hint-b", "clock-hint-c"]) {
      const translated = translateSessionId(raw, "codex");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(Math.abs(sessionClock(translated) - now)).toBeLessThan(60_000);
    }
  });

  // 上游 ce060c79 的同类断言：前缀里的时间是铸造成时刻，不是摘要出来的。
  it("mints translated sessions at the current time instead of from a digest", () => {
    const TIME_MASK = (1n << 36n) - 1n;
    const timeOf = (id) => Number((~BigInt(`0x${id.slice(4, 16)}`) & ((1n << 48n) - 1n)) >> 12n);
    const before = Date.now();
    const translated = translateSessionId(`fresh-${before}`, "claude");
    const after = Date.now();

    expect(timeOf(translated)).toBeGreaterThanOrEqual(Number(BigInt(before) & TIME_MASK));
    expect(timeOf(translated)).toBeLessThanOrEqual(Number(BigInt(after) & TIME_MASK));
  });

  it("reuses the memoized session for one conversation", () => {
    const raw = "claude:memoized-conversation";
    const first = translateSessionId(raw, "claude");
    expect(translateSessionId(raw, "claude")).toBe(first);
    expect(translateSessionId(`${raw}-other`, "claude")).not.toBe(first);
  });
  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });
});

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["Authorization"]).toBe("Bearer public");
  });
  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  it("defaults User-Agent to the v2 CLI form for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toBe("opencode/latest/2.0.26/cli");

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
  });

  it("replaces v1-style opencode User-Agents, which upstream now rejects with 403", () => {
    const executor = getExecutor("opencode");
    for (const ua of ["opencode", "opencode/1.15.0", "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"]) {
      expect(executor.buildHeaders({ rawHeaders: { "user-agent": ua } })["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
    }
  });

  it("preserves a v2 opencode downstream User-Agent", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/latest/2.0.29/desktop" } });
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/desktop");
  });

  it("sends the v2 session headers and never x-opencode-request", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({
      rawHeaders: { "x-opencode-request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
    });
    const session = headers["x-opencode-session"];
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["x-session-id"]).toBe(session);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect("x-opencode-request" in headers).toBe(false);
  });
});

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("isolates stable sessions by downstream identity", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forKey = (auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forKey("user-A")).not.toBe(forKey("user-B"));
    expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("ignores the synthetic UUID plus timestamp seed chatCore sends", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const credentials = anonymousCredentials("app-default-key");
    const call = (seed) => executor.prepareRequestCredentials({
      body,
      credentials,
      providerSessionId: seed,
      clientTool: "generic",
    })._opencodeSession;

    const first = call("3f1c9f8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f1792940000000");
    const second = call("8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d1792940000001");

    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("scopes fresh conversations on one connection by their first user message", () => {
    const executor = getExecutor("opencode");
    const credentials = anonymousCredentials("app-default-key");
    const call = (text) => executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: text }] },
      credentials,
      providerSessionId: "3f1c9f8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f1792940000000",
      clientTool: "generic",
    })._opencodeSession;

    const first = call("explain the retry path");
    expect(call("explain the retry path")).toBe(first);
    expect(call("write a different question")).not.toBe(first);
  });

  it("keeps a synthetic-seeded multi-turn conversation on one current-dated session", () => {
    const executor = getExecutor("opencode");
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "a long enough assistant reply to anchor the conversation hash" },
        { role: "user", content: "again" },
      ],
    };
    const credentials = anonymousCredentials("app-multiturn-key");
    const call = (seed) => executor.prepareRequestCredentials({
      body,
      credentials,
      providerSessionId: seed,
      clientTool: "generic",
    })._opencodeSession;

    const first = call("3f1c9f8e-1a2b-4c3d-8e4f-5a6b7c8d9e0f1792940000000");
    const second = call("8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d1792940000001");

    expect(second).toBe(first);
    const clock = Number((~BigInt(`0x${first.slice(4, 16)}`) & ((1n << 48n) - 1n)) >> 12n);
    expect(Math.abs(clock - (Date.now() % 2 ** 36))).toBeLessThan(60_000);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("keeps the stable session on an IP-scoped 429", async () => {
    const executor = getExecutor("opencode");
    const credentials = { connectionId: "rotate-conn", rawHeaders: {} };
    const limited = () => new Response(JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
    }), { status: 429, headers: { "content-type": "application/json", "retry-after": "36000" } });
    fetchMock.mockResolvedValueOnce(limited());

    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials,
    });

    // Free-pool quota is IP/short-window scoped; a fresh session does not help.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const session = fetchMock.mock.calls[0][1].headers["x-opencode-session"];
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(result.response.status).toBe(429);
  });

  it("rotates and retries once on a session-scoped 429", async () => {
    const executor = getExecutor("opencode");
    const credentials = { connectionId: "rate-conn", rawHeaders: {} };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: "error",
        error: { type: "RateLimitError", message: "Too many requests." },
      }), { status: 429, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSession = fetchMock.mock.calls[0][1].headers["x-opencode-session"];
    const secondSession = fetchMock.mock.calls[1][1].headers["x-opencode-session"];
    expect(firstSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).not.toBe(firstSession);
    expect(result.response.status).toBe(200);
  });

  it("rotates a session translated from a downstream hint and retries once", async () => {
    const executor = getExecutor("opencode");
    const credentials = { connectionId: "hint-conn", rawHeaders: {} };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: "error",
        error: { type: "RateLimitError", message: "Too many requests." },
      }), { status: 429, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-hint",
      clientTool: "claude",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSession = fetchMock.mock.calls[0][1].headers["x-opencode-session"];
    const secondSession = fetchMock.mock.calls[1][1].headers["x-opencode-session"];
    expect(firstSession).toBe(translateSessionId("conversation-hint", "claude", "direct"));
    expect(secondSession).not.toBe(firstSession);
    expect(result.response.status).toBe(200);
  });


  it("applies the read/shell free-tier fingerprint on Chat Completions", () => {
    const executor = getExecutor("opencode");

    const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chatNoTools.stream).toBe(true);
    // tool_choice "none" is answered with 403 FreeTierError upstream.
    expect(chatNoTools.tool_choice).toBeUndefined();
    expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual(["read", "shell"]);
    expect(chatNoTools.messages[0].role).toBe("system");

    const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
        { type: "function", function: { name: "Read", description: "Claude Code tool" } },
      ],
      tool_choice: "auto",
    });
    expect(chatWithTools.tool_choice).toBe("auto");
    // 2026-10-30 起：caller 工具名统一改成中性别名 fn_<hash>（实测真名会吃 429），
    // 指纹工具照旧追加在后面。别名按名字哈希，跨轮次稳定。
    const chatWithToolsNames = chatWithTools.tools.map((t) => t.function?.name);
    expect(chatWithToolsNames.slice(2)).toEqual(["read", "shell"]);
    expect(chatWithToolsNames[0]).toMatch(/^fn_[0-9a-z]{7}$/);
    expect(chatWithToolsNames[1]).toMatch(/^fn_[0-9a-z]{7}$/);
    // 同一个真名必须永远得到同一个别名（按名字哈希），否则跨轮次的 prefix cache 会被打散。
    const again = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
        { type: "function", function: { name: "Read", description: "Claude Code tool" } },
      ],
      tool_choice: "auto",
    });
    expect(again.tools.map((t) => t.function?.name).slice(0, 2)).toEqual(chatWithToolsNames.slice(0, 2));

    const chatClash = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "existing" } }],
    });
    expect(chatClash.tools.map((t) => t.function?.name)).toEqual(["read_client", "read", "shell"]);
    expect(chatClash.tools[0].function.description).toBe("existing");
  });

  it("cloaks Muse Responses requests even when the client already supplies tools", () => {
    const executor = getExecutor("opencode");
    const transformed = executor.transformRequest("muse-spark-1.3-contributor-free(xhigh)", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "zcode_search",
        description: "client-provided tool",
        parameters: { type: "object", properties: {} },
      }],
      tool_choice: "auto",
      reasoning_effort: "xhigh",
    }, true, {});

    expect(transformed.stream).toBe(true);
    expect(transformed.reasoning?.effort).toBe("xhigh");
    // 同上：客户端工具换成中性别名，还原表映射回 zcode_search。
    const museNames = transformed.tools.map((tool) => tool.name);
    expect(museNames.slice(1)).toEqual(["read", "shell"]);
    expect(museNames[0]).toMatch(/^fn_[0-9a-z]{7}$/);
    const museMap = takeRenamedToolNames(transformed);
    expect(restoreToolNames({ content: [{ type: "tool_use", name: museNames[0] }] }, museMap).content[0].name)
      .toBe("zcode_search");
    expect(transformed.instructions).toMatch(/Do not call the `read` or `shell` tools/);
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});
