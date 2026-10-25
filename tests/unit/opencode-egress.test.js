import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  default: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode.js";
import {
  resetEgressState,
  identifyFixedEgress,
  getEgressCooldown,
  markEgressCooling,
} from "../../open-sse/utils/egress.js";

const MODEL = "nemotron-3-ultra-free";
const TARGET = "https://opencode.ai/inference/v1/chat/completions";

function pool(id, url, extra = {}) {
  return {
    proxyPoolId: id,
    connectionProxyEnabled: true,
    connectionProxyUrl: url,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
    ...extra,
  };
}

function okResponse() {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rateLimitedResponse({ headers = {}, body = {} } = {}) {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "FreeUsageLimitError",
      message: "Free usage limit reached.",
      ...body,
    },
  }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeBody(text = "hello") {
  return {
    messages: [{ role: "user", content: text }],
    tools: [{ type: "function", function: { name: "read", description: "client read" } }],
  };
}

function run(executor, { body, proxyOptions, providerSessionId, credentials = { rawHeaders: {} } }) {
  return executor.execute({
    model: MODEL,
    body,
    stream: false,
    credentials,
    providerSessionId,
    clientTool: "claude",
    proxyOptions,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  resetEgressState();
});

describe("OpenCode free-lane egress switching", () => {
  it("on 429: cools the current proxy, switches proxy + session, and retries exactly once with the original body", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const alternate = pool("b", "http://proxy-b.example:8080");
    const proxyOptions = { ...primary, connectionProxyAlternates: [alternate] };
    const body = makeBody("retry-body");

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse({ headers: { "retry-after": "120" } }))
      .mockResolvedValueOnce(okResponse());

    const result = await run(executor, { body, proxyOptions, providerSessionId: "conv-switch-1" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = fetchMock.mock.calls[0];
    const second = fetchMock.mock.calls[1];
    expect(first[2].connectionProxyUrl).toBe("http://proxy-a.example:8080");
    expect(second[2].connectionProxyUrl).toBe("http://proxy-b.example:8080");

    const firstSession = first[1].headers["x-opencode-session"];
    const secondSession = second[1].headers["x-opencode-session"];
    expect(firstSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).toMatch(OPENCODE_SESSION_RE);
    expect(secondSession).not.toBe(firstSession);

    expect(JSON.parse(second[1].body)).toEqual(JSON.parse(first[1].body));

    expect(getEgressCooldown(identifyFixedEgress(TARGET, primary))?.retryAfterMs).toBeGreaterThan(110_000);
    expect(getEgressCooldown(identifyFixedEgress(TARGET, alternate))).toBeNull();
  });

  it("retries only once when the alternate is also rate-limited", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const alternate = pool("b", "http://proxy-b.example:8080");
    const proxyOptions = { ...primary, connectionProxyAlternates: [alternate] };

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse({ headers: { "retry-after": "60" } }))
      .mockResolvedValueOnce(rateLimitedResponse({ headers: { "retry-after": "30" } }));

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-once" });

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getEgressCooldown(identifyFixedEgress(TARGET, primary))).not.toBeNull();
    expect(getEgressCooldown(identifyFixedEgress(TARGET, alternate))).not.toBeNull();
  });

  it("proactively moves off a cooling egress before sending", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const alternate = pool("b", "http://proxy-b.example:8080");
    const proxyOptions = { ...primary, connectionProxyAlternates: [alternate] };

    markEgressCooling(identifyFixedEgress(TARGET, primary), 120_000);
    fetchMock.mockResolvedValueOnce(okResponse());

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-proactive" });

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][2].connectionProxyUrl).toBe("http://proxy-b.example:8080");
  });

  it("answers locally with the remaining Retry-After when every egress is cooling", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const alternate = pool("b", "http://proxy-b.example:8080");
    const proxyOptions = { ...primary, connectionProxyAlternates: [alternate] };

    markEgressCooling(identifyFixedEgress(TARGET, primary), 120_000);
    markEgressCooling(identifyFixedEgress(TARGET, alternate), 45_000);

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-local" });

    expect(result.response.status).toBe(429);
    expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(40);
    expect(Number(result.response.headers.get("retry-after"))).toBeLessThanOrEqual(45);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses Retry-After from the 429 body when the header is absent", async () => {
    const executor = getExecutor("opencode");
    const primary = pool("a", "http://proxy-a.example:8080");
    const proxyOptions = { ...primary, connectionProxyAlternates: [] };

    fetchMock.mockResolvedValueOnce(rateLimitedResponse({ body: { retry_after: 90 } }));

    const result = await run(executor, { body: makeBody(), proxyOptions, providerSessionId: "conv-body-retry" });

    expect(result.response.status).toBe(429);
    const cooldown = getEgressCooldown(identifyFixedEgress(TARGET, primary));
    expect(cooldown?.retryAfterMs).toBeGreaterThan(80_000);
    expect(cooldown?.retryAfterMs).toBeLessThanOrEqual(90_000);
  });

  it("preserves a native x-opencode-session across an egress switch", async () => {
    const executor = getExecutor("opencode");
    const native = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const primary = pool("a", "http://proxy-a.example:8080");
    const alternate = pool("b", "http://proxy-b.example:8080");
    const proxyOptions = { ...primary, connectionProxyAlternates: [alternate] };

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse({ headers: { "retry-after": "10" } }))
      .mockResolvedValueOnce(okResponse());

    await run(executor, {
      body: makeBody(),
      proxyOptions,
      providerSessionId: "conv-native",
      credentials: { rawHeaders: { "x-opencode-session": native } },
    });

    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(native);
    expect(fetchMock.mock.calls[1][1].headers["x-opencode-session"]).toBe(native);
  });

  it("mints one session per (conversation, egress) and reuses it while the egress is stable", () => {
    const executor = getExecutor("opencode");
    const credentials = { rawHeaders: {} };
    const body = makeBody();
    const prepare = (egressId) => executor.prepareRequestCredentials({
      body,
      credentials,
      providerSessionId: "conv-session-egress",
      clientTool: "claude",
      egressId,
    })._opencodeSession;

    const onA = prepare("proxy:a");
    const onA2 = prepare("proxy:a");
    const onB = prepare("proxy:b");

    expect(onA).toBe(onA2);
    expect(onB).not.toBe(onA);
    expect(onA).toMatch(OPENCODE_SESSION_RE);
    expect(onB).toMatch(OPENCODE_SESSION_RE);
  });

  it("does not probe direct egress on the normal path", async () => {
    const executor = getExecutor("opencode");
    fetchMock.mockResolvedValueOnce(okResponse());

    await run(executor, { body: makeBody(), proxyOptions: null, providerSessionId: "conv-no-probe" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
