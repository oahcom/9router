import { beforeEach, describe, expect, it, vi } from "vitest";

const { transportMock, bumpMock, failureSeq, rotateMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  // 按调用序给出失败原因：第一发（首发）与第二发（重放）可以不同，
  // 才能覆盖「重放拿到 caller-aborted 不该 strike 线路」的口径。
  const failureSeq = { values: [] };
  const transportMock = vi.fn(async (url, options = {}) => {
    const reason = failureSeq.values.length ? failureSeq.values.shift() : "header-timeout";
    if (reason) options.transportFailure = reason;
    return null;
  });
  return { transportMock, bumpMock: vi.fn(), failureSeq, rotateMock: vi.fn() };
});

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: transportMock,
  bumpTransportGeneration: bumpMock,
  resetTransport: vi.fn(),
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: () => true,
  asipEgressForPort: async () => ({ egress: null, since: null }),
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

function makeArgs(proxyUrl) {
  return {
    model: "deepseek-v4.1-flash-free",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: { connectionId: "conn", rawHeaders: {} },
    ...(proxyUrl ? { proxyOptions: { url: proxyUrl, enabled: true } } : {}),
  };
}

beforeEach(() => {
  transportMock.mockClear();
  bumpMock.mockClear();
  rotateMock.mockReset();
  // 默认：asip 不换线（line_ok）——正是「第二击必须上报」的场景
  rotateMock.mockResolvedValue({ reason: "line_ok", switched: false });
  failureSeq.values = ["header-timeout", "header-timeout"];
  resetEgressState();
});

describe("重放 transport 失败的第二击上报（line_ok 二击出局）", () => {
  it("重放又 stall 时补一次 reason=transport 上报，且不再重放", async () => {
    const executor = getExecutor("opencode");
    const result = await executor.execute(makeArgs("http://127.0.0.1:7895"));

    // 首发 + 重放共两发，绝无第三发（「绝不再重放」语义保持）
    expect(transportMock).toHaveBeenCalledTimes(2);
    // 两次 rotateEgress("transport")：首发报障 + 重放失败的第二击
    const reasons = rotateMock.mock.calls.map((c) => c[0]);
    expect(reasons).toEqual(["transport", "transport"]);
    // 第二击的记账指向重放真正走的端口
    const second = rotateMock.mock.calls[1][1];
    expect(second.proxyUrl).toBe("http://127.0.0.1:7895");
    // 请求仍按原设计以 503 牺牲（不加尾跳）
    expect(result.response.status).toBe(503);
  });

  it("重放拿到 caller-aborted（客户端断开）不 strike 线路", async () => {
    failureSeq.values = ["header-timeout", "caller-aborted"];
    const executor = getExecutor("opencode");
    await executor.execute(makeArgs("http://127.0.0.1:7895"));

    // 只有首发那一次报障；caller-aborted 不是线路坏的证据
    const reasons = rotateMock.mock.calls.map((c) => c[0]);
    expect(reasons).toEqual(["transport"]);
  });

  it("重放拿到 429 走原有记账，不重复第二击 transport 上报", async () => {
    // 第一发 transport stall（合成 503），第二发（重放）拿到真实 429 响应。
    transportMock.mockImplementationOnce(async (url, options = {}) => {
      options.transportFailure = "header-timeout";
      return null;
    });
    transportMock.mockImplementationOnce(async () => {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "10" },
      });
    });
    const executor = getExecutor("opencode");
    await executor.execute(makeArgs("http://127.0.0.1:7895"));

    const reasons = rotateMock.mock.calls.map((c) => c[0]);
    // 第一击 transport + 重放 429 的 rate429 记账；没有多余的第二击
    expect(reasons).toEqual(["transport", "rate429"]);
  });
});

describe("清池范围：只失效相关端口（旧语义不变，爆炸半径收窄）", () => {
  it("换线目标不同时，失败端口与目标端口都失效、不碰无关端口", async () => {
    rotateMock.mockResolvedValue({
      reason: "ok", switched: true,
      switchToUrl: "http://127.0.0.1:7896", switchToEgress: "1.2.3.4",
    });
    const executor = getExecutor("opencode");
    await executor.execute(makeArgs("http://127.0.0.1:7895"));

    const bumpArgs = bumpMock.mock.calls.map((c) => c[0]);
    expect(bumpArgs).toContain("http://127.0.0.1:7895");
    expect(bumpArgs).toContain("http://127.0.0.1:7896");
    // 已知端口时绝不无参（=全局）bump
    expect(bumpArgs.every((a) => a !== undefined)).toBe(true);
  });

  it("asip 不换线（line_ok）时只失效原端口", async () => {
    const executor = getExecutor("opencode");
    await executor.execute(makeArgs("http://127.0.0.1:7895"));

    const bumpArgs = bumpMock.mock.calls.map((c) => c[0]);
    expect(bumpArgs).toContain("http://127.0.0.1:7895");
    expect(bumpArgs).not.toContain("http://127.0.0.1:7896");
    expect(bumpArgs.every((a) => a !== undefined)).toBe(true);
  });

  it("URL 判不出来时回退全局（与旧行为一致）", async () => {
    // 无 proxyOptions 时会落到 env 代理（测试环境 http_proxy=127.0.0.1:7000），
    // 那仍是精确清池。真正拿不到 URL 的只有全直连：把代理环境变量清掉。
    const saved = {};
    for (const k of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY",
      "all_proxy", "ALL_PROXY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const executor = getExecutor("opencode");
      await executor.execute(makeArgs(null));

      const bumpArgs = bumpMock.mock.calls.map((c) => c[0]);
      // 直连 → 上报/清池都拿不到端口，回退全局语义（与旧无参调用一致）
      expect(bumpArgs.length).toBeGreaterThan(0);
      expect(bumpArgs.every((a) => a === undefined)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });
});
