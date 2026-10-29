import { beforeEach, describe, expect, it, vi } from "vitest";

const { transportMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  return { transportMock: vi.fn(async () => null) };
});

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: transportMock,
  bumpTransportGeneration: vi.fn(),
  resetTransport: vi.fn(),
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const PRIMARY = "socks5h://127.0.0.1:1080";
const ALTERNATE = "socks5h://127.0.0.1:1081";

function proxyOptionsWithAlternate() {
  return {
    enabled: true,
    url: PRIMARY,
    connectionProxyUrl: PRIMARY,
    connectionProxyEnabled: true,
    connectionProxyAlternates: [
      {
        connectionProxyEnabled: true,
        connectionProxyUrl: ALTERNATE,
        url: ALTERNATE,
      },
    ],
  };
}

beforeEach(() => {
  transportMock.mockClear();
  resetEgressState();
});

describe("OpenCode transport failure failover", () => {
  it("retries once on the alternate egress when the transport stalls", async () => {
    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
      proxyOptions: proxyOptionsWithAlternate(),
    });

    expect(transportMock).toHaveBeenCalledTimes(2);
    const failoverProxy = transportMock.mock.calls[1][2];
    expect(failoverProxy?.url).toBe(ALTERNATE);
    // 两次都挂 → 仍返回 503，但不会标记出口冷却（503 不是出口级证据）
    expect(result.response.status).toBe(503);
  });

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
});
