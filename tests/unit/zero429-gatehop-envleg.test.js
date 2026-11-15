import { beforeEach, describe, expect, it, vi } from "vitest";

// 零 429 泄漏修复契约（2026-11-15 21:12 生产泄漏 whutr1uza/whuu4edze/whuu6vezg）。
// 两条断链各锁一件事：
//   1. gate-hop 新鲜节点续试：池闸尝试 429 后，daemon 给出没试过的新节点
//      必须继续打（zero-429），旧「1-attempt budget; stop here」无条件弃单。
//   2. gate-hop 池跳 2 发封顶：第 2 个池节点仍 429 后收手（D14 成本上限）。
//   3. env 代理腿接线（#33 DefaultExecutor 路径）：连接级没配代理、流量走
//      进程级 HTTPS_PROXY 的请求，429 必须触发换线+重试（旧判据只看
//      proxyOptions 字段 → 只剩 A1 记账不救，whuu6vezg 17s 外泄）。

const { fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock, egressMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  return {
    fetchMock: vi.fn(),
    rotateMock: vi.fn(),
    enabledMock: vi.fn(() => true),
    bumpMock: vi.fn(),
    cooldownMock: vi.fn(),
    egressMock: vi.fn(async () => ({ egress: null, since: null })),
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
  default: fetchMock,
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  bumpTransportGeneration: bumpMock,
  fetchViaTransport: vi.fn(async () => null),
  resetTransport: vi.fn(),
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: enabledMock,
  asipEgressForPort: egressMock,
  markAsipProxyCooling: cooldownMock,
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const MODEL = "deepseek-v4.1-flash-free";

function gatePool() {
  return {
    proxyPoolId: "solo",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://127.0.0.1:7897",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

function ok() {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function rateLimited() {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function body(text) {
  return { messages: [{ role: "user", content: text }], tools: [] };
}

function rotateOk({ url = null, node = null, egress = null } = {}) {
  return {
    switched: true,
    switchedAt: Date.now(),
    reason: "ok",
    switchToUrl: url,
    switchToNode: node,
    switchToEgress: egress,
    activeEgress: null,
    restartRequired: false,
    lineChanged: true,
  };
}

async function runOpencode(text, opts = {}) {
  const executor = getExecutor("opencode");
  const logWarn = vi.fn();
  const result = await executor.execute({
    model: MODEL,
    body: body(text),
    stream: false,
    credentials: { rawHeaders: {} },
    clientTool: "claude",
    proxyOptions: opts.pool || gatePool(),
    providerSessionId: "conv-gh-" + text,
    log: { warn: logWarn, debug: vi.fn(), info: vi.fn() },
    reqId: "gh" + text,
  });
  return { result, logWarn };
}

function warned(logWarn, needle) {
  return logWarn.mock.calls.some((args) =>
    args.some((a) => typeof a === "string" && a.includes(needle)),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateMock.mockReset();
  cooldownMock.mockReset();
  enabledMock.mockReset();
  enabledMock.mockReturnValue(true);
  bumpMock.mockReset();
  egressMock.mockReset();
  egressMock.mockResolvedValue({ egress: null, since: null });
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  resetEgressState();
});

describe("gate-hop fresh-node continuation (zero-429)", () => {
  it("continues on a fresh pool node instead of sacrificing after the first pool attempt", async () => {
    // 链路复刻 whutr1uza：首发 429 -> 换线到池闸节点 A（也 429）-> 记账换线
    // 回新节点 B。旧实现在 A 的 429 后直接 stop here 弃单；修复后必须打 B 并采纳 200。
    fetchMock
      .mockResolvedValueOnce(rateLimited()) // 首发
      .mockResolvedValueOnce(rateLimited()) // 池节点 A
      .mockResolvedValueOnce(ok());        // 池节点 B（fresh）-> 200
    rotateMock
      // 初始记账+换线：给池节点 A
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-a" }))
      // A 429 后记账：给 fresh 池节点 B
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-b" }));

    const { result, logWarn } = await runOpencode("fresh-node-continue");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.response.status).toBe(200);
    expect(warned(logWarn, "continue (zero-429)")).toBe(true);
    expect(warned(logWarn, "stop here")).toBe(false);
  });

  it("stops at the pool 2-attempt cap when the second pool node also 429s", async () => {
    // 池节点 A、B 都 429 后 daemon 给节点 C：triedPoolNodes.size>=2 -> 收手（D14 成本上限）。
    fetchMock
      .mockResolvedValueOnce(rateLimited()) // 首发
      .mockResolvedValueOnce(rateLimited()) // 池节点 A
      .mockResolvedValueOnce(rateLimited()); // 池节点 B
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-a" }))
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-b" }))
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-c" }));

    const { result, logWarn } = await runOpencode("pool-cap-two");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.response.status).toBe(429);
    expect(warned(logWarn, "pool 2-attempt cap")).toBe(true);
  });

  it("still stops immediately when asip offers a repeated node", async () => {
    // 同节点重放没有任何新意：必须维持旧「不再白烧池节点」语义。
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited());
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-a" }))
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7897", node: "node-a" }));

    const { result, logWarn } = await runOpencode("same-node-stop");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(429);
    expect(warned(logWarn, "no fresh node")).toBe(true);
  });
});

describe("env-proxy leg wires DefaultExecutor 429 rotation (#33)", () => {
  it("rotates and retries a 429 when only the process env proxy points at a local gate", async () => {
    // 复刻 whuu6vezg：连接级无代理（proxyOptions 空），流量走 HTTPS_PROXY=7890。
    // 修复前 base.js 判 false -> 429 直接外泄（只有 A1 记账）；修复后必须
    // 换线（rotateEgress 被调）+ 重试（第二发 fetch）并采纳 200。
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const executor = getExecutor("openai-compatible-chat-envleg");
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7893", egress: "eg-fresh" }));

    const logWarn = vi.fn();
    const result = await executor.execute({
      model: MODEL,
      body: body("env-leg-rotate"),
      stream: false,
      credentials: { rawHeaders: {} },
      providerSessionId: "conv-envleg",
      log: { warn: logWarn, debug: vi.fn(), info: vi.fn() },
      reqId: "envleg1",
      proxyOptions: {},
    });

    expect(rotateMock).toHaveBeenCalled();
    const call = rotateMock.mock.calls[0];
    expect(call[0]).toBe("rate429");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("does not rotate when no proxy (env or connection) points at a local gate", async () => {
    // 判据对称性：真直连（无 env 代理、无连接代理）不能进换线环（白烧出口）。
    const executor = getExecutor("openai-compatible-chat-direct");
    fetchMock.mockResolvedValueOnce(rateLimited());

    const result = await executor.execute({
      model: MODEL,
      body: body("direct-no-rotate"),
      stream: false,
      credentials: { rawHeaders: {} },
      providerSessionId: "conv-direct",
      log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
      reqId: "direct1",
      proxyOptions: {},
    });

    expect(rotateMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });
});
