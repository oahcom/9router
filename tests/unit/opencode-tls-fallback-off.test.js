// 默认 off 的那一半：sidecar 不可用时不许悄悄退回 undici，要回可重试的 503，
// 而且 proxyAwareFetch 一次都不该被调用（没有 directFetch 钩子可给）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, transportMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  delete process.env.OPENCODE_TLS_FALLBACK; // 默认就是 off
  return { fetchMock: vi.fn(), transportMock: vi.fn(async () => null) };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: transportMock,
  bumpTransportGeneration: vi.fn(),
  resetTransport: vi.fn(),
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: vi.fn(),
  OpencodeTlsUnavailableError: class extends Error {},
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

beforeEach(() => {
  fetchMock.mockReset();
  transportMock.mockClear();
  resetEgressState();
});

describe("OpenCode TLS fallback when the flag is off", () => {
  it("answers a retryable 503 and never hands proxyAwareFetch a directFetch hook", async () => {
    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    expect(transportMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("retry-after")).toBe("1");
    expect(result.response.headers.get("x-transport-error-type")).toBe("synthetic");
  });
});
