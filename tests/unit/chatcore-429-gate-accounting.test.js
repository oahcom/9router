// A1 判据回归：chatCore 的 429 记账只对「经本机 asip 闸口（环回 + 可换端口）」
// 出去的请求生效。直连 / 外部代理 / 非闸口端口 / vercel relay 的 429 不得喂给
// /rotate —— daemon 端 egress_proxy_url 匹配不到槽位时会落到 legacy 主出口
// 路径，把无关的主出口 IP 标脏（默认封 12h）并切线，殃及同出口的其他流量。
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock, rotateMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  rotateMock: vi.fn(async () => ({
    switched: true,
    switchedAt: Date.now(),
    reason: "ok",
    lineChanged: false,
  })),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

// asipRotate 被 chatCore / proxyFetch / base.js 共用 —— mock 工厂一次补齐
// 全部导出，漏一项就会在传递加载时报 "No X export is defined on the mock"。
vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: () => true,
  asipEgressForPort: async () => ({ egress: null, since: null }),
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
  markAsipProxyCooling: vi.fn(),
  isAsipProxyCooling: () => false,
  clearAsipProxyCooling: vi.fn(),
  requestAsipSelfRestart: vi.fn(),
  resetAsipSelfRestartForTest: vi.fn(),
  resetAsipSelfRestartMemoryForTest: vi.fn(),
  notePortLine: vi.fn(),
  egressForPort: () => null,
  refreshSlotEgress: async () => {},
  resetPortLinesForTest: vi.fn(),
  noteActiveLine: vi.fn(),
  forgetActiveLine: vi.fn(),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

async function run429(providerSpecificData) {
  executeMock.mockResolvedValue({
    response: new Response(
      JSON.stringify({ error: { type: "RateLimitError", message: "quota exceeded" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } },
    ),
    url: "https://api.opencode.ai/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });

  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() };
  const result = await handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData },
    log,
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
  });
  return { result, log };
}

async function runUpstream(status, providerSpecificData) {
  executeMock.mockResolvedValue({
    response: new Response(
      JSON.stringify({ error: { message: "upstream says no" } }),
      { status, headers: { "content-type": "application/json", "retry-after": "30" } },
    ),
    url: "https://api.opencode.ai/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });

  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() };
  const result = await handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData },
    log,
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
  });
  return { result, log };
}

describe("chatCore 429 accounting gate (A1 predicate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("local asip gate proxy → rotateEgress fires with the gate URL and Retry-After", async () => {
    await run429({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7892",
    });

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).toHaveBeenCalledWith(
      "rate429",
      expect.objectContaining({
        proxyUrl: "http://127.0.0.1:7892",
        retryAfterMs: 30000,
      }),
    );
  });

  it("gate port 7890 (slot-1) also counts as local gate", async () => {
    await run429({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7890",
    });

    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it("direct connection (no proxy) → rotateEgress NOT called", async () => {
    await run429({});
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("external proxy → rotateEgress NOT called (429 is not ours to rotate)", async () => {
    await run429({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://10.0.0.1:8080",
    });
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("loopback but non-gate port (127.0.0.1:7000) → rotateEgress NOT called", async () => {
    await run429({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7000",
    });
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("proxy URL set but connectionProxyEnabled=false → request did not use it, NOT called", async () => {
    await run429({
      connectionProxyEnabled: false,
      connectionProxyUrl: "http://127.0.0.1:7892",
    });
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("vercel relay takes precedence over connection proxy → NOT called", async () => {
    await run429({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7892",
      vercelRelayUrl: "https://relay.example.com",
    });
    expect(rotateMock).not.toHaveBeenCalled();
  });
});

// 终场 429 → 合成 503（零 429 红线，哨兵口径，2026-11-16）：
// 换线环打光后（或无闸可换）的 429 不出客户端出口——合成可重试 503 +
// 透传 Retry-After，真实 429 留在 TX-ATTEMPT / A1 记账供审计。日志同步
// 503 口径（哨兵 grep "ERROR 429"）。
describe("terminal 429 synthesized to 503 (zero-429 red line)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("local gate terminal 429 → client gets synthetic 503 with Retry-After preserved", async () => {
    const { result, log } = await run429({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7892",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.response.status).toBe(503);
    // Retry-After 透传走 header 通道（upstreamResponseHeaders 白名单含 retry-after）
    expect(result.response.headers.get("retry-after")).toBe("30");
    const body = await result.response.json();
    expect(body.error.message).toContain("synthesized");
    expect(result.response.headers.get("x-transport-failure")).toBe("upstream-rate-limited");
    expect(result.response.headers.get("x-transport-error-type")).toBe("synthetic");
    // 真实 429 照常记账（内部审计线不断）
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).toHaveBeenCalledWith("rate429", expect.objectContaining({ retryAfterMs: 30000 }));
    // 日志口径：ERROR 503（不得出现 ERROR 429，哨兵查这个）
    const errLine = String(log.errorLine.mock.calls?.[0]?.[2] ?? "");
    expect(errLine).toContain("ERROR 503");
    expect(errLine).not.toContain("ERROR 429");
  });

  it("direct-connection terminal 429 (rotation on) → also synthesized 503", async () => {
    // 生产红线按「出口 0 个 429」计——只要 asip 轮换在役，终场 429 一律合成
    const { result, log } = await run429({});
    expect(result.status).toBe(503);
    const errLine = String(log.errorLine.mock.calls?.[0]?.[2] ?? "");
    expect(errLine).not.toContain("ERROR 429");
  });

  it("non-429 upstream errors pass through untouched", async () => {
    const { result } = await runUpstream(500, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7892",
    });
    expect(result.status).toBe(500);
    expect(result.response.headers.get("x-transport-failure")).toBeNull();
  });
});
