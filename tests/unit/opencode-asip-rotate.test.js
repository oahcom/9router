import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, rotateMock, enabledMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  return {
    fetchMock: vi.fn(),
    rotateMock: vi.fn(),
    enabledMock: vi.fn(() => true),
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
  default: fetchMock,
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: enabledMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const MODEL = "deepseek-v4.1-flash-free";

function soloPool() {
  return {
    proxyPoolId: "solo",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://solo.example:8080",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

function ok() {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function rateLimited() {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function body(text) {
  return { messages: [{ role: "user", content: text }], tools: [] };
}

async function run(text = "hi") {
  const executor = getExecutor("opencode");
  return executor.execute({
    model: MODEL,
    body: body(text),
    stream: false,
    credentials: { rawHeaders: {} },
    clientTool: "claude",
    proxyOptions: soloPool(),
    providerSessionId: "conv-solo-" + text,
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    reqId: "solo12345",
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateMock.mockReset();
  enabledMock.mockReset();
  enabledMock.mockReturnValue(true);
  resetEgressState();
});

describe("asip rotation without an alternate pool", () => {
  it("asks asip to rotate even when no alternate proxy is configured", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());
    rotateMock.mockImplementation(async () => ({ switched: true, switchedAt: Date.now(), reason: "ok" }));

    const result = await run("rotate");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("does not retry when asip declines the rotation", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "too_frequent" });

    const result = await run("declined");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it("skips asip entirely when rotation is disabled", async () => {
    enabledMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(rateLimited());

    const result = await run("disabled");

    expect(rotateMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });
});
