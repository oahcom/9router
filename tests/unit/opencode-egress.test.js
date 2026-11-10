import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, rotateMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  return { fetchMock: vi.fn(), rotateMock: vi.fn() };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
  default: fetchMock,
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: () => true,
  // 执行器每个请求读一次当前出口地址，429 时交给 asip 查换线表。
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode.js";
import {
  resetEgressState,
  identifyFixedEgress,
  getEgressCooldown,
  markEgressCooling,
} from "../../open-sse/utils/egress.js";

const MODEL = "nemotron-3-ultra-free";
const TARGET = "https://opencode.ai/inference/v1/chat/completions";

function pool(id, url, extra = {}) {
  return {
    proxyPoolId: id,
    connectionProxyEnabled: true,
    connectionProxyUrl: url,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
    ...extra,
  };
}

function okResponse() {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rateLimitedResponse({ headers = {}, body = {}, type = "FreeUsageLimitError" } = {}) {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type,
      message: "Free usage limit reached.",
      ...body,
    },
  }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeBody(text = "hello") {
  return {
    messages: [{ role: "user", content: text }],
    tools: [{ type: "function", function: { name: "read", description: "client read" } }],
  };
}

// 系统提示里的工作目录是每次 execute 现生成的随机临时路径，不属于「body 被改写」
// 的范畴。比对前抹成占位符，其余结构仍逐字段严格比对。
function normalizedBody(raw) {
  const scrub = (value) => {
    if (typeof value === "string") {
      return value.replace(
        /(Working directory: |Workspace root folder: )\S+/g,
        "$1<runtime-tmp>",
      );
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, inner] of Object.entries(value)) out[key] = scrub(inner);
      return out;
    }
    return value;
  };
  return scrub(JSON.parse(raw));
}

function run(executor, { body, proxyOptions, providerSessionId, credentials = { rawHeaders: {} } }) {
  return executor.execute({
    model: MODEL,
    body,
    stream: false,
    credentials,
    providerSessionId,
    clientTool: "claude",
    proxyOptions,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateMock.mockReset();
  resetEgressState();
});

// 备选出口机制已整个删除（单池布局下恒为空集）。429 之后唯一还能换来新出口的
// 动作是 asip 换线，所以这一组用例断言的都是「asip 换了 / 没换」两条路。
function asipRotated() {
  rotateMock.mockImplementation(async () => ({ switched: true, switchedAt: Date.now(), reason: "ok" }));
}

describe("OpenCode free-lane egress switching", () => {
  it("on 429: asks asip, then retries exactly once with the original body", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    const body = makeBody("retry-body");
    asipRotated();

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse({ type: "RateLimitError", headers: { "retry-after": "120" } }))
      .mockResolvedValueOnce(okResponse());

    const result = await run(executor, { body, proxyOptions, providerSessionId: "conv-switch-1" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rotateMock).toHaveBeenCalledTimes(1);

    const first = fetchMock.mock.calls[0];
    const second = fetchMock.mock.calls[1];
    // 出口没有第二个可选，两次都必须落在同一条 proxy 上 —— 变的只有隧道。
    expect(first[2].connectionProxyUrl).toBe("http://proxy-a.example:8080");
    expect(second[2].connectionProxyUrl).toBe("http://proxy-a.example:8080");

    const firstSession = first[1].headers["x-opencode-session"];
    const secondSession = second[1].headers["x-opencode-session"];
    expect(firstSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).toMatch(OPENCODE_SESSION_RE);
    // 换的是隧道不是出口：出口 id 没变，会话也就没必要换。会话按 (对话, 出口) 铸造，
    // 出口没变化时换会话只会让上游看到一个凭空出现的新身份。
    expect(secondSession).toBe(firstSession);

    expect(normalizedBody(second[1].body)).toEqual(normalizedBody(first[1].body));

    // Fixed proxy egresses are not cooled here: sing-box owns the exit IP and
    // rotates it underneath the same proxy URL.
    expect(getEgressCooldown(identifyFixedEgress(TARGET, primary))).toBeNull();
  });

  it("on a FreeUsageLimitError: still asks asip, and the session follows the egress", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    const body = makeBody("ip-scoped");
    asipRotated();

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okResponse());

    const result = await run(executor, { body, proxyOptions, providerSessionId: "conv-free-ip" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0];
    const second = fetchMock.mock.calls[1];
    // The IP is quota-limited; asip swaps it underneath the same proxy URL.
    expect(first[2].connectionProxyUrl).toBe("http://proxy-a.example:8080");
    expect(second[2].connectionProxyUrl).toBe("http://proxy-a.example:8080");
    expect(normalizedBody(second[1].body)).toEqual(normalizedBody(first[1].body));
  });


  it("on a direct-egress FreeUsageLimitError: keeps the body and retries on the same egress", async () => {
    const executor = getExecutor("opencode");
    // Direct primary: no connectionProxyUrl.
    const proxyOptions = {
      proxyPoolId: null,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    };
    const body = makeBody("direct-quota");
    asipRotated();

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okResponse());

    const result = await run(executor, { body, proxyOptions, providerSessionId: "conv-direct-quota" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0];
    const second = fetchMock.mock.calls[1];
    expect(first[2].connectionProxyUrl || "").toBe("");
    expect(second[2].connectionProxyUrl || "").toBe("");
    expect(normalizedBody(second[1].body)).toEqual(normalizedBody(first[1].body));
    // The retry carries a well-formed session; it differs from attempt 1 only
    // because sessions are scoped to the egress (sessionScopeKey = identity +
    // egressId), not because a quota 429 forces an epoch rotation. Measured
    // 2026-10-28: reusing one session across egresses is accepted upstream, so
    // neither shape matters to the quota — the exit IP does.
    expect(second[1].headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
  });
  it("tags every EGRESS warn with the request id it was given", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    const warn = vi.fn();
    const log = { warn, debug: vi.fn(), info: vi.fn() };
    asipRotated();

    fetchMock.mockResolvedValueOnce(rateLimitedResponse()).mockResolvedValueOnce(okResponse());

    const result = await executor.execute({
      model: MODEL,
      body: makeBody("tagged"),
      stream: false,
      credentials: { rawHeaders: {} },
      clientTool: "claude",
      proxyOptions,
      providerSessionId: "conv-tagged",
      log,
      reqId: "abc1234",
    });

    expect(result.response.status).toBe(200);
    const messages = warn.mock.calls.map((call) => String(call[1]));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.includes("(req=abc1234)"))).toBe(true);
  });

  it("survives a namespace logger whose warn is getter-only", async () => {
    // 2026-10-30 01:28 线上 502 的复现：log 是 webpack 模块导出对象，warn 只有 getter。
    // 旧实现 Object.create(log) 之后直接赋值 -> TypeError: Cannot set property warn of
    // #<Object> which has only a getter，每个请求直接 502。普通对象 {warn} 测不出来。
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    const warn = vi.fn();
    const namespaceLog = Object.create(null);
    Object.defineProperty(namespaceLog, "warn", { get: () => warn, enumerable: true });
    Object.defineProperty(namespaceLog, "debug", { value: vi.fn(), enumerable: true });
    Object.defineProperty(namespaceLog, "info", { value: vi.fn(), enumerable: true });
    asipRotated();

    fetchMock.mockResolvedValueOnce(rateLimitedResponse()).mockResolvedValueOnce(okResponse());

    const result = await executor.execute({
      model: MODEL,
      body: makeBody("getter-only"),
      stream: false,
      credentials: { rawHeaders: {} },
      clientTool: "claude",
      proxyOptions,
      providerSessionId: "conv-getter-only",
      log: namespaceLog,
      reqId: "abc9999",
    });

    expect(result.response.status).toBe(200);
    expect(warn.mock.calls.some((call) => String(call[1]).includes("(req=abc9999)"))).toBe(true);
  });

  it("leaves warn lines untagged when no request id is supplied", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    const warn = vi.fn();
    const log = { warn, debug: vi.fn(), info: vi.fn() };
    asipRotated();

    fetchMock.mockResolvedValueOnce(rateLimitedResponse()).mockResolvedValueOnce(okResponse());

    const result = await executor.execute({
      model: MODEL,
      body: makeBody("untagged"),
      stream: false,
      credentials: { rawHeaders: {} },
      clientTool: "claude",
      proxyOptions,
      providerSessionId: "conv-untagged",
      log,
    });

    expect(result.response.status).toBe(200);
    const messages = warn.mock.calls.map((call) => String(call[1]));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => !message.includes("req="))).toBe(true);
  });
  it("stops after the configured attempt budget when asip rotation never fixes the 429", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    asipRotated();

    // 首发 + OPENCODE_ROTATE_ATTEMPTS(默认 3) 发，每发都换线、每发都 429。
    fetchMock.mockResolvedValue(rateLimitedResponse({ type: "RateLimitError", headers: { "retry-after": "30" } }));

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-once" });

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getEgressCooldown(identifyFixedEgress(TARGET, primary))).toBeNull();
  });

  it("keeps a fixed proxy when asked to cool it (the rotation manager owns the exit IP)", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };

    markEgressCooling(identifyFixedEgress(TARGET, primary), 120_000);
    fetchMock.mockResolvedValueOnce(okResponse());

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-proactive" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][2].connectionProxyUrl).toBe("http://proxy-a.example:8080");
  });

  it("returns the 429 without cooling a fixed proxy when Retry-After is only in the body", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };
    asipRotated();

    fetchMock.mockResolvedValue(rateLimitedResponse({ type: "RateLimitError", body: { retry_after: 90 } }));

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-body-retry" });

    expect(result.response.status).toBe(429);
    expect(getEgressCooldown(identifyFixedEgress(TARGET, primary))).toBeNull();
  });

  it("preserves a native x-opencode-session across an egress switch", async () => {
    const executor = getExecutor("opencode");
    const native = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary };

    fetchMock.mockResolvedValueOnce(okResponse());

    await run(executor, {
      body: makeBody(),
      proxyOptions,
      providerSessionId: "conv-native",
      credentials: { rawHeaders: { "x-opencode-session": native } },
    });

    const sent = fetchMock.mock.calls[0][1].headers["x-opencode-session"];
    expect(sent).toBe(native);
  });

  it("mints one session per (conversation, egress) and reuses it while the egress is stable", () => {
    const executor = getExecutor("opencode");
    const credentials = { rawHeaders: {} };
    const body = makeBody();
    const prepare = (egressId) => executor.prepareRequestCredentials({
      body,
      credentials,
      providerSessionId: "conv-session-egress",
      clientTool: "claude",
      egressId,
    })._opencodeSession;

    const onA = prepare("proxy:a");
    const onA2 = prepare("proxy:a");
    const onB = prepare("proxy:b");

    expect(onA).toBe(onA2);
    expect(onB).not.toBe(onA);
    expect(onA).toMatch(OPENCODE_SESSION_RE);
    expect(onB).toMatch(OPENCODE_SESSION_RE);
  });

  it("does not probe direct egress on the normal path", async () => {
    const executor = getExecutor("opencode");
    fetchMock.mockResolvedValueOnce(okResponse());

    await run(executor, { body: makeBody(), proxyOptions: null, providerSessionId: "conv-no-probe" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
