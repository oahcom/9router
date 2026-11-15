import { beforeEach, describe, expect, it, vi } from "vitest";

// P0-2 / P0-3 契约测试（2026-11-15）。
//   P0-2 连接池精准清：invalidateEgressConnections 只动本次涉及的出口；
//     旧 `oldUrl || undefined` 会落到 clearProxyDispatchers() 的整池 clear()
//     与 bumpTransportGeneration(null) 的 globalGen 全端口 bump —— 一次换线
//     把同进程其它在途请求的暖连接/ sidecar 会话全部陪葬。契约：
//     a) 10 并发只换 1 个 → 其余 9 个的 URL 绝不出现在失效调用里；
//     b) 出口未知（null）→ 一次失效调用都不许有（不许整池屠杀）。
//   P0-3 参数耦合守卫：预算 × 链长 × 单发超时的耦合值锁进 CI。
//     改 MAX_ROTATE_ATTEMPTS / ROTATE_ATTEMPT_BUDGET_MS / headerTimeout* /
//     MAX_429_SENDS 必须显式 ack —— 更新本文件的期望数字并在提交说明影响。

const { fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock, egressMock, clearSpy } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  return {
    fetchMock: vi.fn(),
    rotateMock: vi.fn(),
    enabledMock: vi.fn(() => true),
    bumpMock: vi.fn(),
    cooldownMock: vi.fn(),
    egressMock: vi.fn(async () => ({ egress: null, since: null })),
    clearSpy: vi.fn(),
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: clearSpy,
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
import { invalidateEgressConnections, MAX_ROTATE_ATTEMPTS, ROTATE_ATTEMPT_BUDGET_MS } from "../../open-sse/executors/opencode.js";
import { MAX_429_SENDS, ROTATE_429_BUDGET_MS } from "../../open-sse/executors/base.js";
import { OPENCODE_TRANSPORT_CONFIG, FETCH_CONNECT_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const MODEL = "deepseek-v4.1-flash-free";

function ok() {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function rateLimited() {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function body(text) {
  return { messages: [{ role: "user", content: text }], tools: [] };
}

function proxyOpts(url) {
  return {
    proxyPoolId: "p-" + url,
    connectionProxyEnabled: true,
    connectionProxyUrl: url,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

async function run(text, url, extra = {}) {
  const executor = getExecutor("opencode");
  return await executor.execute({
    model: MODEL,
    body: body(text),
    stream: false,
    credentials: { rawHeaders: {} },
    clientTool: "claude",
    proxyOptions: proxyOpts(url),
    providerSessionId: "conv-p02-" + text,
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    reqId: "p02" + text,
    ...extra,
  });
}

function calledWithUndefinedOrEmpty(spy) {
  return spy.mock.calls.some((args) => args.length === 0 || args[0] === undefined || args[0] === null);
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateMock.mockReset();
  cooldownMock.mockReset();
  enabledMock.mockReset();
  enabledMock.mockReturnValue(true);
  bumpMock.mockReset();
  clearSpy.mockReset();
  egressMock.mockReset();
  egressMock.mockResolvedValue({ egress: null, since: null });
  resetEgressState();
});

describe("P0-2 precise pool invalidation (no collateral damage)", () => {
  it("10 concurrent requests, one rotates: only its own egresses get invalidated", async () => {
    // 10 并发、各自独立出口；req0 走 429 -> 换线 -> 重试 200，其余 9 个直接 200。
    // 断言：clearSpy/bumpMock 只碰过 req0 的旧/新两个 URL，其余 9 个绝不陪葬。
    const URLS = Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${17990 + i}`);
    const ROTATE_TO = "http://127.0.0.1:17980";

    // req0：429 -> 200；其余：一次 200（按 body 文本身份分流）
    let req0Calls = 0;
    const body0 = body("req-zero");
    fetchMock.mockImplementation(async (_url, opts) => {
      const b = typeof opts?.body === "string" ? opts.body : "";
      if (b.includes("req-zero")) {
        req0Calls += 1;
        return req0Calls === 1 ? rateLimited() : ok();
      }
      return ok();
    });
    rotateMock.mockResolvedValueOnce({
      switched: true,
      switchedAt: Date.now(),
      reason: "ok",
      switchToUrl: ROTATE_TO,
      switchToNode: null,
      switchToEgress: "eg-fresh",
      activeEgress: null,
      restartRequired: false,
      lineChanged: true,
    });

    const executor = getExecutor("opencode");
    const tasks = URLS.map((u, i) =>
      executor.execute({
        model: MODEL,
        body: i === 0 ? body0 : body("req-" + i),
        stream: false,
        credentials: { rawHeaders: {} },
        clientTool: "claude",
        proxyOptions: proxyOpts(u),
        providerSessionId: "conv-conc-" + i,
        log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
        reqId: "conc" + i,
      }),
    );
    const results = await Promise.all(tasks);

    expect(results[0].response.status).toBe(200);
    for (const r of results.slice(1)) expect(r.response.status).toBe(200);

    // 失效调用只许动 req0 自己的出口（旧 URL 与/或新 URL），其余 9 个绝不陪葬
    const clearArgs = clearSpy.mock.calls.map((a) => a[0]);
    const bumpArgs = bumpMock.mock.calls.map((a) => a[0]);
    for (const a of clearArgs) expect([URLS[0], ROTATE_TO]).toContain(a);
    for (const a of bumpArgs) expect([URLS[0], ROTATE_TO]).toContain(a);
    for (const u of URLS.slice(1)) {
      expect(clearArgs).not.toContain(u);
      expect(bumpArgs).not.toContain(u);
    }
    expect(calledWithUndefinedOrEmpty(clearSpy)).toBe(false);
    expect(calledWithUndefinedOrEmpty(bumpMock)).toBe(false);
  });

  it("unknown old egress must not mass-clear the pool or bump global generation", () => {
    // 出口未知（直连/未指派）：旧实现 `oldUrl || undefined` -> 整池 clear()
    // + globalGen bump（杀掉所有端口的 sidecar 会话）。修复后必须一次都不动。
    invalidateEgressConnections(null, null);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(bumpMock).not.toHaveBeenCalled();

    invalidateEgressConnections(undefined, undefined);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(bumpMock).not.toHaveBeenCalled();
  });

  it("same-URL rotation invalidates exactly once", () => {
    // 同端口换线（newUrl === oldUrl）：只失效一次，不重复打。
    invalidateEgressConnections("http://127.0.0.1:7890", "http://127.0.0.1:7890");
    expect(clearSpy.mock.calls.map((a) => a[0])).toEqual(["http://127.0.0.1:7890"]);
    expect(bumpMock.mock.calls.map((a) => a[0])).toEqual(["http://127.0.0.1:7890"]);
  });
});

describe("P0-3 parameter coupling guard (explicit ack required)", () => {
  it("ACK 2026-11-15: rotate budget x chain length x header timeout x 429 sends", () => {
    // ──── 显式 ack 区 ────
    // 如需变更以下任何数字：必须同步更新本行日期与期望值，并在提交说明中
    // 写明对「429 外泄面 / 超时面 / 池节点成本」的影响。不改这里 = CI 红。
    expect(MAX_ROTATE_ATTEMPTS).toBe(6);
    expect(ROTATE_ATTEMPT_BUDGET_MS).toBe(25000);
    expect(MAX_429_SENDS).toBe(3);
    expect(ROTATE_429_BUDGET_MS).toBe(25000);
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs).toBe(20000);
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBe(45000);
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMaxMs).toBe(55000);
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutPer500kbMs).toBe(15000);
  });

  it("invariants: budget covers one send, caps nest, sends bounded by chain", () => {
    // 耦合不变量（结构性，不随调参失效）：
    // 1. 链预算必须容得下至少一次完整 header 等待，否则首发超时即预算耗尽（whdtocshq 教训）
    expect(ROTATE_ATTEMPT_BUDGET_MS).toBeGreaterThanOrEqual(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs);
    // 2. 重放预算不得超过 header 封顶；封顶不得超过…封顶
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBeLessThanOrEqual(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMaxMs);
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs).toBeLessThan(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs);
    // 3. base.js 429 发数不得多于换线环容量（3×3 发爆炸的防线）
    expect(MAX_429_SENDS).toBeLessThanOrEqual(MAX_ROTATE_ATTEMPTS);
    expect(ROTATE_429_BUDGET_MS).toBeLessThanOrEqual(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMaxMs);
    // 4. 连接超时必须长于 header 超时基线（否则 connect 闸先触发，header 闸形同虚设）
    expect(FETCH_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs);
  });
});
