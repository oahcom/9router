import { beforeEach, describe, expect, it, vi } from "vitest";

const { rotateMock, enabledMock } = vi.hoisted(() => ({
  rotateMock: vi.fn(),
  enabledMock: vi.fn(() => true),
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: enabledMock,
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  clearProxyDispatchers: vi.fn(),
  default: vi.fn(),
}));

import { BaseExecutor, resetConnectTimeoutRotateState } from "../../open-sse/executors/base.js";

// 本机 sing-box 的地址（9router 代理池里实际配的就是它）。
const LOCAL_PROXY = { url: "http://127.0.0.1:7890" };
// 局域网里另一台机器的同名端口：换本机 asip 对它没有任何影响。
const LAN_PROXY = { url: "http://192.168.100.104:7890" };

function ok() {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 构造一个只有连接行为的探针执行器。
 *
 * `outcomes` 按调用次序消费："timeout" = 连响应头都建不起来（等 connectTimer
 * 触发 abort 后抛 AbortError，与真实 undici 的行为一致）；"ok" = 正常返回。
 */
function makeExecutor(outcomes) {
  class Probe extends BaseExecutor {
    constructor() {
      super("probe", { baseUrls: ["https://upstream.example/v1/chat/completions"], timeoutMs: 20 });
      this.calls = 0;
      this.pending = outcomes.slice();
    }

    buildHeaders() {
      return {};
    }

    async fetchUpstream(url, options) {
      const outcome = this.pending.length ? this.pending.shift() : "ok";
      this.calls += 1;
      if (outcome === "ok") return ok();
      return await new Promise((_, reject) => {
        const fail = () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (options?.signal?.aborted) return fail();
        options?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
  }
  return new Probe();
}

async function run(executor, proxyOptions) {
  return await executor.execute({
    model: "probe-model",
    body: { messages: [] },
    stream: false,
    credentials: {},
    signal: new AbortController().signal,
    log: null,
    proxyOptions,
  });
}

beforeEach(() => {
  resetConnectTimeoutRotateState();
  rotateMock.mockReset();
  enabledMock.mockReset();
  enabledMock.mockReturnValue(true);
  rotateMock.mockResolvedValue({ switched: true, switchedAt: Date.now(), reason: "transport" });
});

describe("base executor: 连接超时换线", () => {
  it("经本机 sing-box 的连接超时先换线，再用同一条 URL 重试一次", async () => {
    const executor = makeExecutor(["timeout", "ok"]);

    const result = await run(executor, LOCAL_PROXY);

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock.mock.calls[0][0]).toBe("transport");
    expect(executor.calls, "换线后应当只重试一次，没有第二次").toBe(2);
    expect(result.response.status).toBe(200);
  });

  it("局域网代理不换线：换本机 WARP 线对它没有任何作用", async () => {
    const executor = makeExecutor(["timeout"]);

    await expect(run(executor, LAN_PROXY)).rejects.toThrow(/aborted/i);

    expect(rotateMock).toHaveBeenCalledTimes(0);
    expect(executor.calls, "不该因为换不了线而多试一轮").toBe(1);
  });

  it("asip 拒绝换线时保持原来的直接抛出，不再白等第二个 60s", async () => {
    rotateMock.mockResolvedValue({ switched: false, switchedAt: 0, reason: "timeout" });
    const executor = makeExecutor(["timeout"]);

    await expect(run(executor, LOCAL_PROXY)).rejects.toThrow(/aborted/i);

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(executor.calls).toBe(1);
  });

  it("并发合并（switched=false 但 switchedAt 有值）也算换过线，仍值得重试", async () => {
    rotateMock.mockResolvedValue({ switched: false, switchedAt: Date.now(), reason: "coalesced" });
    const executor = makeExecutor(["timeout", "ok"]);

    const result = await run(executor, LOCAL_PROXY);

    expect(executor.calls).toBe(2);
    expect(result.response.status).toBe(200);
  });

  it("一次请求最多换一次线：换完还超时就抛出，不滚成风暴", async () => {
    const executor = makeExecutor(["timeout", "timeout"]);

    await expect(run(executor, LOCAL_PROXY)).rejects.toThrow(/aborted/i);

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(executor.calls).toBe(2);
  });

  it("冷却窗口内的下一个请求不再重复换线", async () => {
    const first = makeExecutor(["timeout", "ok"]);
    await run(first, LOCAL_PROXY);
    expect(rotateMock).toHaveBeenCalledTimes(1);

    const second = makeExecutor(["timeout"]);
    await expect(run(second, LOCAL_PROXY)).rejects.toThrow(/aborted/i);

    expect(rotateMock, "15s 内第二次请求不该再烧一条出口").toHaveBeenCalledTimes(1);
  });

  it("asip 整体关闭时连本地 socket 都不碰", async () => {
    enabledMock.mockReturnValue(false);
    const executor = makeExecutor(["timeout"]);

    await expect(run(executor, LOCAL_PROXY)).rejects.toThrow(/aborted/i);

    expect(rotateMock).toHaveBeenCalledTimes(0);
  });

  it("没有配代理时（直连）不换线", async () => {
    const executor = makeExecutor(["timeout"]);

    await expect(run(executor, null)).rejects.toThrow(/aborted/i);

    expect(rotateMock).toHaveBeenCalledTimes(0);
  });
});
