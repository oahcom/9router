import { beforeEach, describe, expect, it, vi } from "vitest";

const { transportMock, bumpMock, failureRef, rotateMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  const failureRef = { value: null };
  // 与真实实现同一个契约：失败原因写进本次调用的 options，不再靠模块级变量。
  const transportMock = vi.fn(async (url, options = {}) => {
    if (failureRef.value) options.transportFailure = failureRef.value;
    return null;
  });
  return { transportMock, bumpMock: vi.fn(), failureRef, rotateMock: vi.fn() };
});

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: transportMock,
  bumpTransportGeneration: bumpMock,
  resetTransport: vi.fn(),
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: () => true,
  // 执行器每个请求读一次当前出口地址，429 时交给 asip 查换线表。
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const PRIMARY = "socks5h://127.0.0.1:1080";
// 生产是非 socks 的 http 出口（127.0.0.1:7890）。socks 会在 fetchUpstream 里
// 被结构性不支持分支提前短接，走不到「合成 503 + failure 标签」那条路 ——
// 拿 socks 测重试判定等于测了个别的分支。

beforeEach(() => {
  transportMock.mockClear();
  bumpMock.mockClear();
  rotateMock.mockReset();
  failureRef.value = null;
  resetEgressState();
});

describe("OpenCode transport failure failover", () => {
  it("does not retry when no alternate egress is configured", async () => {
    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    expect(transportMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(503);
  });

  // 单池部署（两个 proxy pool 同指 127.0.0.1:7890）选不出备选出口，
  // 无首字节超时曾经一次都不重试，直接冒 503 给 combo。
  it("retries once on a fresh connection when a header stall hits a single-pool egress", async () => {
    failureRef.value = "header-timeout";
    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    expect(transportMock, "无首字节超时应当重试一次").toHaveBeenCalledTimes(2);
    expect(bumpMock, "重试必须换 generation，否则骑着同一条死 socket").toHaveBeenCalled();
    expect(result.response.status).toBe(503);
  });

  // 多端口：asip 在 transport 这条路上同样会指定一台健康 sing-box。不跟着走
  // 的话，重放仍然撞在原来那台已经卡死的进程上 —— 等于只换了个 generation。
  it("moves the stall replay onto the port asip named", async () => {
    failureRef.value = "header-timeout";
    rotateMock.mockResolvedValueOnce({
      switched: true,
      switchedAt: Date.now(),
      reason: "ok",
      switchToUrl: "http://127.0.0.1:7893",
      switchToEgress: "2606:slot3::1",
      avoidPortUntil: 0,
    });
    const executor = getExecutor("opencode");
    await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    expect(transportMock).toHaveBeenCalledTimes(2);
    // 3rd arg 就是传给 proxyAwareFetch/侧车的 proxyOptions。
    expect(transportMock.mock.calls[1][2].url).toBe("http://127.0.0.1:7893");
    expect(transportMock.mock.calls[1][2].enabled).toBe(true);
  });

  // 实测 10:33:18 换线成功 → 10:33:20 撞 429 → 重试 → 10:33:38 header timeout
  // → 直接 503 返回客户端。429 末尾那次重试绕开了 503 处理段，那条路上
  // 曾经一次都不重试。
  it("retries once when the 429 retry itself hits a header stall", async () => {
    rotateMock.mockImplementation(async () => ({ switched: true, switchedAt: Date.now(), reason: "ok" }));
    transportMock.mockImplementationOnce(async (url, options = {}) => {
      options.transportFailure = "header-timeout";
      return new Response(
        JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Rate limit exceeded" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    });
    transportMock.mockImplementation(async (url, options = {}) => {
      options.transportFailure = "header-timeout";
      return null;
    });

    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    // 1 次 429 → 1 次 429 后的重试（拿回 header stall）→ 1 次补的 stall 重试
    expect(transportMock, "429 后的重试撞上无首字节超时必须再补一次").toHaveBeenCalledTimes(3);
    expect(result.response.status).toBe(503);
  });

  it("does not retry a single-pool failure that is not a header stall", async () => {
    failureRef.value = "unsupported-proxy:socks5";
    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    // 结构性不支持时 executeInner 直接返回 503，不会自己重试。
    // 多出来的一次来自 compose 层的重试判定，不在这条分支里 —— 这里只钉住
    // 「没有备选出口可换，也不会换成别的出口」。
    expect(result.response.status).toBe(503);
    const urls = transportMock.mock.calls.map((call) => call[2]?.connectionProxyUrl ?? null);
    expect(new Set(urls).size, "没有备选出口，每次都必须落在同一条出口上").toBe(1);
  });
});
