import { beforeEach, describe, expect, it, vi } from "vitest";

// 零漏出（2026-11-14「有闸口可用时 0 生产 429 打出」）：
// ① 重放拿到 429 且记账给出新闸口 → 回 executeInner 续试，不再把 429 牺牲给客户端；
//   「绝不再重放」保持（重放全程仅一次，续试走首发+换线环）。
// ② 记账拿不到新闸口（无闸口可用）→ 429 原样交回，属合理漏出。
// ③ 换线环封顶 3→6：只要 asip 一路给新闸口就继续试（旧封顶 3 会把第 4 条
//   健康线晾在一边直接打死）。
const { transportMock, bumpMock, rotateMock, seq } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  const seq = { handlers: [] };
  const transportMock = vi.fn(async (url, options = {}) => {
    const h = seq.handlers.shift();
    return h ? h(url, options) : null;
  });
  return { transportMock, bumpMock: vi.fn(), rotateMock: vi.fn(), seq };
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
  markAsipProxyCooling: vi.fn(),
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const okResponse = () =>
  new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const rate429Response = () =>
  new Response(JSON.stringify({ error: { message: "rate limited" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "10" },
  });

const stallOnce = (reason = "header-timeout") => async (url, options = {}) => {
  options.transportFailure = reason;
  return null;
};

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
  seq.handlers = [];
  resetEgressState();
});

describe("零漏出：重放 429 后有新闸口则续试（不牺牲给客户端）", () => {
  it("重放 429 + 记账给新闸口 → 回 executeInner 续试成功，无第二次重放", async () => {
    // 发 1：首发 stall；发 2：重放 429；发 3：续试（executeInner 首发）200。
    seq.handlers = [stallOnce(), async () => rate429Response(), async () => okResponse()];
    rotateMock.mockImplementation(async (reason) => {
      if (reason === "transport") {
        return { reason: "ok", switched: true, switchToUrl: "http://127.0.0.1:7894", switchToEgress: "2001:db8::aaaa" };
      }
      // rate429 记账：给出下一条线（新端口 + 新出口）= 有闸口可用
      return { reason: "ok", switched: true, switchToUrl: "http://127.0.0.1:7893", switchToEgress: "2001:db8::bbbb" };
    });

    const executor = getExecutor("opencode");
    const result = await executor.execute(makeArgs("http://127.0.0.1:7895"));

    expect(result.response.status).toBe(200);
    // 首发 + 重放 + 续试 = 3 发；重放仅一次（绝不再重放语义保持）
    expect(transportMock).toHaveBeenCalledTimes(3);
    // 记账齐全：transport 报障 + rate429 记账（续试走首发，不新增记账口径）
    const reasons = rotateMock.mock.calls.map((c) => c[0]);
    expect(reasons).toEqual(["transport", "rate429"]);
  });

  it("重放 429 + 记账无新闸口 → 429 原样交回（无闸口，合理漏出）", async () => {
    seq.handlers = [stallOnce(), async () => rate429Response()];
    rotateMock.mockResolvedValue({ reason: "line_ok", switched: false });

    const executor = getExecutor("opencode");
    const result = await executor.execute(makeArgs("http://127.0.0.1:7895"));

    expect(result.response.status).toBe(429);
    expect(transportMock).toHaveBeenCalledTimes(2);
  });
});

describe("零漏出：换线环封顶 6（旧 3 会打死仍有闸口的请求）", () => {
  it("asip 一路给新闸口时连试 5 条备线共 6 发，第 6 发成功", async () => {
    // 首发 429，随后 4 发 429，第 6 发 200。旧封顶 3：第 3 发后放弃 → 429 漏出。
    const ports = [7894, 7893, 7892, 7890, 7896];
    const egresses = ["2001:db8::1", "2001:db8::2", "2001:db8::3", "2001:db8::4", "2001:db8::5"];
    seq.handlers = [
      async () => rate429Response(),
      async () => rate429Response(),
      async () => rate429Response(),
      async () => rate429Response(),
      async () => rate429Response(),
      async () => okResponse(),
    ];
    let call = 0;
    rotateMock.mockImplementation(async () => {
      const i = call++;
      return {
        reason: "ok",
        switched: true,
        switchToUrl: `http://127.0.0.1:${ports[i]}`,
        switchToEgress: egresses[i],
      };
    });

    const executor = getExecutor("opencode");
    const result = await executor.execute(makeArgs("http://127.0.0.1:7895"));

    expect(result.response.status).toBe(200);
    expect(transportMock).toHaveBeenCalledTimes(6);
  });

  it("asip 不再给新闸口时提前放弃（防死循环语义保持）", async () => {
    seq.handlers = [async () => rate429Response(), async () => rate429Response()];
    rotateMock.mockResolvedValue({ reason: "line_ok", switched: false });

    const executor = getExecutor("opencode");
    const result = await executor.execute(makeArgs("http://127.0.0.1:7895"));

    expect(result.response.status).toBe(429);
    // 首发 1 发后，换线环首跳被判「no new egress」拒绝（同址/无新线不白打）
    expect(transportMock).toHaveBeenCalledTimes(1);
  });
});
