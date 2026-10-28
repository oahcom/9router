// OPENCODE_TLS_FALLBACK 的闸：默认 off 时 sidecar 不在就回可重试的 503；
// 开成 on 时（且没有配置代理、也没有环境变量代理）才落到 wreq-js 的 TLS 会话。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, transportMock, tlsMock, Unavailable } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  process.env.OPENCODE_TLS_FALLBACK = "on";
  for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    delete process.env[key];
  }
  class OpencodeTlsUnavailable extends Error {}
  return {
    fetchMock: vi.fn(),
    transportMock: vi.fn(async () => null),
    tlsMock: vi.fn(async () => new Response("{}", { status: 200 })),
    Unavailable: OpencodeTlsUnavailable,
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: transportMock,
  resetTransport: vi.fn(),
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsMock,
  OpencodeTlsUnavailableError: Unavailable,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const runOnce = (executor) =>
  executor.execute({
    model: "deepseek-v4.1-flash-free",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: { connectionId: "conn", rawHeaders: {} },
  });

beforeEach(() => {
  fetchMock.mockReset();
  transportMock.mockClear();
  tlsMock.mockClear();
  resetEgressState();
});

describe("OpenCode TLS fallback gate", () => {
  it("hands proxyAwareFetch a directFetch hook once the flag is on", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const executor = getExecutor("opencode");

    const result = await runOnce(executor);
    expect(result.response.status).toBe(200);

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("opencode");
    expect(options.directFetch).toBeTypeOf("function");

    // 这个钩子必须真的接到 wreq-js 上（而不是又落回 undici），而且不能给它
    // 整请求超时 —— 这条车道只有流式，120s 会把长回答拦腰 abort。
    await options.directFetch(url, { method: "POST", headers: {}, body: "{}" });
    expect(tlsMock).toHaveBeenCalledTimes(1);
    expect(tlsMock.mock.calls[0][0]).toBe(url);
    expect(tlsMock.mock.calls[0][2]).toMatchObject({ timeoutMs: null });
  });

  it("answers a retryable 503 — not a thrown error — when wreq-js is missing", async () => {
    fetchMock.mockRejectedValueOnce(new Unavailable("wreq-js unavailable"));
    const executor = getExecutor("opencode");

    const result = await runOnce(executor);
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("retry-after")).toBe("1");
    expect(result.response.headers.get("x-transport-error-type")).toBe("synthetic");
    const body = await result.response.json();
    expect(body.error.type).toBe("UpstreamTransportError");
  });
});
