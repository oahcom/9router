import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, rotateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  rotateMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
  default: fetchMock,
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: () => true,
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { BaseExecutor } from "../../open-sse/executors/base.js";

const TARGET = "https://upstream.test/v1/chat/completions";

function makeExecutor(config = {}) {
  // 兼容通道（openai-compatible-*）走的就是 BaseExecutor 的 body：没有自己的
  // 换线逻辑，429 以前只有 tryRetry(attempts: 0) 一条死路。
  return new BaseExecutor("compat", { baseUrl: TARGET, ...config });
}

function okResponse() {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function rateLimited() {
  return new Response(JSON.stringify({
    error: { type: "RateLimitError", message: "too many requests" },
  }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "30" },
  });
}

function localProxy(port = "7890") {
  return {
    proxyPoolId: "pool-a",
    connectionProxyEnabled: true,
    connectionProxyUrl: `http://127.0.0.1:${port}`,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

function run(executor, { proxyOptions, body = { messages: [{ role: "user", content: "hi" }] }, reqId = null }) {
  return executor.execute({
    model: "some-model",
    body,
    stream: false,
    credentials: {},
    proxyOptions,
    reqId,
  });
}

// resolveConnectionProxyUrl 优先读 proxyOptions.url（换线就是改这个字段），
// 没换线时仍是 provider 配的 connectionProxyUrl。
function proxyOf(fetchCall) {
  const options = fetchCall[2];
  return options.url || options.connectionProxyUrl;
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateMock.mockReset();
  delete process.env.EGRESS_429_SENDS;
});

describe("compatible executor 429 egress rotation", () => {
  it("rotates to another gate and retries instead of failing after one send", async () => {
    const executor = makeExecutor();
    rotateMock.mockResolvedValue({
      switched: true,
      switchedAt: Date.now(),
      reason: "ok",
      switchToUrl: "http://127.0.0.1:7893",
      switchToEgress: "2a09:bac5:1111::1",
    });
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(okResponse());

    const result = await run(executor, { proxyOptions: localProxy("7890"), reqId: "req1" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rotateMock).toHaveBeenCalledTimes(1);
    // 第一发在原闸，第二发必须换到 asip 指定的那台。
    expect(proxyOf(fetchMock.mock.calls[0])).toBe("http://127.0.0.1:7890");
    expect(proxyOf(fetchMock.mock.calls[1])).toBe("http://127.0.0.1:7893");
    // 换的是出口不是上游地址：两发打同一个 URL。
    expect(fetchMock.mock.calls[0][0]).toBe(TARGET);
    expect(fetchMock.mock.calls[1][0]).toBe(TARGET);
    // 重放 body 必须与首发一致（transformRequest 不许二次改写）。
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(rotateMock.mock.calls[0][0]).toBe("rate429");
    expect(rotateMock.mock.calls[0][1].reqId).toBe("req1");
  });

  it("gives up after EGRESS_429_SENDS sends", async () => {
    process.env.EGRESS_429_SENDS = "2";
    const executor = makeExecutor();
    rotateMock.mockResolvedValue({
      switched: true,
      switchedAt: Date.now(),
      reason: "ok",
      switchToUrl: "http://127.0.0.1:7894",
      switchToEgress: "2a09:bac5:2222::1",
    });
    fetchMock.mockResolvedValue(rateLimited());

    const result = await run(executor, { proxyOptions: localProxy("7890") });

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to retry when asip hands back an address this request already used", async () => {
    const executor = makeExecutor();
    // 六条线共用一个 /64 池：换一台闸完全可能落回同一个 /128。
    rotateMock.mockResolvedValue({
      switched: true,
      switchedAt: Date.now(),
      reason: "ok",
      switchToUrl: "http://127.0.0.1:7894",
      switchToEgress: "2a09:bac5:3333::1",
    });
    fetchMock.mockResolvedValue(rateLimited());

    const result = await run(executor, { proxyOptions: localProxy("7890") });

    // 首发 7890 → 7894（新地址）；第三发 asip 又给同一个地址 → 拒绝，只打两发。
    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not rotate on a proxy that is not the local sing-box", async () => {
    const executor = makeExecutor();
    fetchMock.mockResolvedValueOnce(rateLimited());

    const result = await run(executor, {
      proxyOptions: { ...localProxy("7890"), connectionProxyUrl: "http://192.168.100.104:7890" },
    });

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("reconnects the same port when asip proves the line was swapped after the send", async () => {
    const executor = makeExecutor();
    // already_retired：没给新端口，但线是在本请求发出之后换的 —— 同端口重连
    // 拿到的就是新地址，这一发值得打。
    rotateMock.mockResolvedValue({
      switched: false,
      switchedAt: Date.now(),
      reason: "already_retired",
      activeEgress: "2a09:bac5:4444::9",
    });
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(okResponse());

    const result = await run(executor, { proxyOptions: localProxy("7895") });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyOf(fetchMock.mock.calls[1])).toBe("http://127.0.0.1:7895");
  });

  it("stops at one send when asip reports no new line and no switch", async () => {
    const executor = makeExecutor();
    rotateMock.mockResolvedValue({
      switched: false,
      switchedAt: 0,
      reason: "coalesced",
      activeEgress: null,
    });
    fetchMock.mockResolvedValue(rateLimited());

    const result = await run(executor, { proxyOptions: localProxy("7896") });

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
