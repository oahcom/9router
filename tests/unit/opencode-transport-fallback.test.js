import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, transportMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "auto";
  return { fetchMock: vi.fn(), transportMock: vi.fn(async () => null) };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  fetchViaTransport: transportMock,
  bumpTransportGeneration: vi.fn(),
  resetTransport: vi.fn(),
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

beforeEach(() => {
  fetchMock.mockReset();
  transportMock.mockClear();
  resetEgressState();
});

describe("OpenCode transport fallback", () => {
  it("refuses to downgrade to Node when the Bun sidecar is unavailable", async () => {
    const executor = getExecutor("opencode");
    const result = await executor.execute({
      model: "deepseek-v4.1-flash-free",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { connectionId: "conn", rawHeaders: {} },
    });

    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("retry-after")).toBe("1");
    const body = await result.response.json();
    expect(body.error.type).toBe("UpstreamTransportError");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
