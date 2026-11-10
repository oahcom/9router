// 代理连不上（fetch failed）时不能一步掉直连。
//
// 2026-11-10 22:57–23:17 实测 282 次 `[ProxyFetch] Proxy failed, falling back
// to direct: fetch failed`，全部落在 asip-unit restart 风暴期间：sing-box 重建
// 中端口短暂不通，代码静默改走本机地址，而本机地址对按 IP 限流的上游必然 429，
// 且不进 asip 的账本 —— 那条请求等于白烧。
//
// 现在改成：先在同一批隧道里换一条重打，最多 3 次，仍不通才直连。
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // proxyFetch 在模块顶层把 globalThis.fetch 抓成 originalFetch，所以必须在
  // 它被 import 之前替换。
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const rotateMock = vi.fn();
  // 常量在模块加载时读取：节流清零便于逐发断言，窗口上限设 3 便于验证硬上限。
  process.env.ASIP_PROXY_FAILURE_GAP_MS = "0";
  process.env.ASIP_PROXY_FAILURE_WINDOW_MAX = "3";
  process.env.ASIP_PROXY_FAILURE_ATTEMPTS = "3";
  return { fetchMock, rotateMock };
});

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: h.rotateMock,
  asipRotationEnabled: () => true,
  // 执行器按端口取出口身份；mock 里一律「未知」，等价于改动前的 null。
  asipEgressForPort: async () => ({ egress: null, since: null }),
  markAsipProxyCooling: () => {},
  resetAsipRotateState: () => {},
}));

const { proxyAwareFetch, resetProxyFailureRotateState } = await import(
  "../../open-sse/utils/proxyFetch.js"
);

const PROXY = "http://127.0.0.1:7890";
const TARGET = "https://api.openai.com/v1/chat/completions";

function fetchFailed() {
  const err = new TypeError("fetch failed");
  err.cause = { code: "ECONNREFUSED" };
  return err;
}

function ok() {
  return new Response("ok", { status: 200 });
}

function proxyOptions(extra = {}) {
  return {
    url: PROXY,
    enabled: true,
    connectionProxyUrl: PROXY,
    connectionProxyEnabled: true,
    strictProxy: false,
    ...extra,
  };
}

function callProxy(options = { method: "POST", body: "{}" }, po = proxyOptions()) {
  return proxyAwareFetch(TARGET, options, po);
}

beforeEach(() => {
  h.fetchMock.mockReset();
  h.rotateMock.mockReset();
  h.rotateMock.mockResolvedValue({ switched: true, switchedAt: Date.now(), reason: "ok" });
  resetProxyFailureRotateState();
});

describe("proxy connect failure rotates through tunnels before going direct", () => {
  it("re-covers on the 2nd tunnel when the 1st rotation still fails", async () => {
    h.fetchMock
      .mockRejectedValueOnce(fetchFailed())
      .mockRejectedValueOnce(fetchFailed())
      .mockResolvedValueOnce(ok());

    const res = await callProxy();

    expect(res.status).toBe(200);
    expect(h.fetchMock).toHaveBeenCalledTimes(3); // 首发 + 2 发换线
    expect(h.rotateMock).toHaveBeenCalledTimes(2);
    expect(h.rotateMock.mock.calls.every(([reason]) => reason === "transport")).toBe(true);
  });

  it("gives up after 3 rotations and only then falls back to direct", async () => {
    h.fetchMock
      .mockRejectedValueOnce(fetchFailed())
      .mockRejectedValueOnce(fetchFailed())
      .mockRejectedValueOnce(fetchFailed())
      .mockRejectedValueOnce(fetchFailed())
      .mockResolvedValueOnce(ok());

    const res = await callProxy();

    expect(res.status).toBe(200);
    expect(h.fetchMock).toHaveBeenCalledTimes(5); // 首发 + 3 发换线 + 1 发直连
    expect(h.rotateMock).toHaveBeenCalledTimes(3);
    // 最后一发是直连：不带 dispatcher（代理路径一定会带）。
    const last = h.fetchMock.mock.calls.at(-1);
    expect(last[1].dispatcher ?? null).toBeNull();
  });

  it("does not retry when the first rotation reports a restart is required", async () => {
    h.fetchMock.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(ok());
    h.rotateMock.mockResolvedValueOnce({ switched: false, restartRequired: true, reason: "restart" });

    const res = await callProxy();

    expect(res.status).toBe(200);
    expect(h.fetchMock).toHaveBeenCalledTimes(2); // 首发 + 直连
    expect(h.rotateMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a body that cannot be replayed", async () => {
    h.fetchMock.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(ok());
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });

    const res = await callProxy({ method: "POST", body });

    expect(res.status).toBe(200);
    expect(h.rotateMock).not.toHaveBeenCalled();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops rotating once the 10s window cap is reached", async () => {
    // 第一次请求把窗口额度用满（3 次换线）。连直连也失败，请求整体抛错——这里
    // 只关心换线次数，不关心最终归属。
    h.fetchMock.mockRejectedValue(fetchFailed());
    await expect(callProxy()).rejects.toThrow();
    expect(h.rotateMock).toHaveBeenCalledTimes(3);

    // 第二次请求：额度已耗尽，一次都不换，直接直连。
    h.fetchMock.mockReset();
    h.rotateMock.mockReset();
    h.fetchMock.mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(ok());
    await callProxy();

    expect(h.rotateMock).not.toHaveBeenCalled();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });
});
