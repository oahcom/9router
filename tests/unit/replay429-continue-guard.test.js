/**
 * 契约测试：replay-429 续试路径的死线黑名单 + 二击上报（2026-11-15 whwgchb0g 复盘）。
 *
 * 复盘事实：首发 7895/HKG-IP stall 20.7s -> 换线 7892/ORD-IP 重放吃 429 ->
 * 记账回包把 next 指回 7895/HKG-IP（daemon 小请求探针判它 OK，大请求挂着）->
 * 旧 freshEgress 的 `||` 只对比重放步失败出口，已死线被当新线放行 ->
 * 同线再 stall 20.7s，49s 才 503；且续试失败零上报，二击出局第二击丢失。
 *
 * 锁三个行为：
 *   A  daemon 回指本请求已死过的口/出口 -> 不续试，快速返回首发的 synthetic 503（无 429 泄漏）
 *   A' daemon 给真新线（新口+新出口）-> 续试照常并采纳 200
 *   B  续试重入后又 stall -> 第二击上报 asip（rotateEgress("transport")）
 *   C  already_retired（同口换出口）不受黑名单影响，仍续试
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock, egressMock,
} = vi.hoisted(() => {
  // 与 zero429-gatehop-envleg 同款：关 sidecar 传输与出口探针，让 fetchUpstream
  // 落到 proxyAwareFetch(=fetchMock) 而不是「Bun transport unavailable」合成 503。
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  return {
    fetchMock: vi.fn(),
    rotateMock: vi.fn(),
    enabledMock: vi.fn(() => true),
    bumpMock: vi.fn(),
    cooldownMock: vi.fn(),
    egressMock: vi.fn(async () => ({ egress: null, since: null })),
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
  default: fetchMock,
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  bumpTransportGeneration: bumpMock,
  fetchViaTransport: vi.fn(async () => null),
  resetTransport: vi.fn(),
}));

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: rotateMock,
  asipRotationEnabled: enabledMock,
  asipEgressForPort: egressMock,
  markAsipProxyCooling: cooldownMock,
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { resetEgressState } from "../../open-sse/utils/egress.js";

const MODEL = "deepseek-v4.1-flash-free";

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

// 与 transport 层合成的停滞 503 同款（x-transport-* 头是 retryOnceAfterStall 的入口钥匙）
function stall503(failure = "header-timeout") {
  return new Response(
    JSON.stringify({ error: { type: "TransportStall", message: "upstream header timeout" } }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-transport-error-type": "synthetic",
        "x-transport-failure": failure,
      },
    },
  );
}

function body(text) {
  return { messages: [{ role: "user", content: text }], tools: [] };
}

function rotateOk({ url = null, node = null, egress = null, reason = "ok", activeEgress = null } = {}) {
  return {
    switched: true,
    switchedAt: Date.now(),
    reason,
    switchToUrl: url,
    switchToNode: node,
    switchToEgress: egress,
    activeEgress,
    restartRequired: false,
    lineChanged: true,
  };
}

const DEAD_URL = "http://127.0.0.1:7895";
const DEAD_EGRESS = "hkg-ip";
const REPLAY_URL = "http://127.0.0.1:7892";
const REPLAY_EGRESS = "ord-ip";

function makeArgs(text) {
  return {
    model: MODEL,
    body: body(text),
    stream: false,
    credentials: { rawHeaders: {} },
    clientTool: "claude",
    proxyOptions: { url: DEAD_URL, enabled: true },
    providerSessionId: "conv-r429-" + text,
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    reqId: "r429-" + text,
    usedCredentials: {},
  };
}

// 直接驱动 retryOnceAfterStall：输入 = 首发 stall 的 synthetic 503，
// context 用首发真实用过的口/出口（生产由 usedCredentials 带出）。
async function runStallReplay(text) {
  const executor = getExecutor("opencode");
  const args = makeArgs(text);
  const result = { response: stall503() };
  const context = {
    requestStartedAt: Date.now(),
    failedEgress: DEAD_EGRESS,
    failedEgressSince: 1,
    proxyUrl: DEAD_URL,
  };
  const out = await executor.retryOnceAfterStall(result, args, context);
  return { out: out ?? result, logWarn: args.log.warn, args };
}

function warned(logWarn, needle) {
  return logWarn.mock.calls.some((call) =>
    call.some((a) => typeof a === "string" && a.includes(needle)),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  rotateMock.mockReset();
  cooldownMock.mockReset();
  enabledMock.mockReset();
  enabledMock.mockReturnValue(true);
  bumpMock.mockReset();
  egressMock.mockReset();
  egressMock.mockResolvedValue({ egress: null, since: null });
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  resetEgressState();
});

describe("replay-429 continue: in-request dead-line blacklist (fix A)", () => {
  it("refuses a daemon next that already died in-request and fails fast with stall 503", async () => {
    // whwgchb0g 全链复刻：首发 7895/HKG-IP stall -> 换线 7892/ORD-IP 重放 429
    // -> 记账回包把 next 指回 7895/HKG-IP。修复前继续续试死线再 stall 20.7s；
    // 修复后必须拒绝并以首发 synthetic 503 快速失败（可重试、无 429 泄漏）。
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: REPLAY_URL, egress: REPLAY_EGRESS })) // transport 换线
      .mockResolvedValueOnce(rotateOk({ url: DEAD_URL, egress: DEAD_EGRESS })); // rate429 记账：回指死线
    fetchMock.mockResolvedValueOnce(rateLimited()); // 重放吃 429

    const { out, logWarn } = await runStallReplay("dead-line-refuse");

    // 只有重放那一发 fetch，死线绝不重打
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 以首发的 stall 503 快速失败，不是 429
    expect(out.response.status).toBe(503);
    expect(out.response.headers.get("x-transport-error-type")).toBe("synthetic");
    expect(warned(logWarn, "already died in-request")).toBe(true);
    expect(warned(logWarn, "no sacrifice")).toBe(false);
    // 两次记账照常发生（transport 换线 + rate429），死线证据没有被吞
    expect(rotateMock).toHaveBeenCalledTimes(2);
    expect(rotateMock.mock.calls[0][0]).toBe("transport");
    expect(rotateMock.mock.calls[1][0]).toBe("rate429");
  });

  it("continues and adopts 200 when daemon gives a genuinely fresh line", async () => {
    // 反向：next 是新口+新出口 -> 续试必须照常（零 429 续试语义不回退）。
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: REPLAY_URL, egress: REPLAY_EGRESS }))
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7893", egress: "fresh-ip" }));
    fetchMock
      .mockResolvedValueOnce(rateLimited()) // 重放 429
      .mockResolvedValueOnce(ok()); // 续试新线 200

    const { out, logWarn } = await runStallReplay("fresh-line-continue");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    expect(warned(logWarn, "no sacrifice")).toBe(true);
    expect(warned(logWarn, "already died in-request")).toBe(false);
  });

  it("reports the 2nd strike to asip when the continued attempt stalls again (fix B)", async () => {
    // 续试重入后又 stall：旧实现直接 return 零上报，trap 线靠 30 分钟探针缓存
    // 连吃下一个请求。修复后必须补 line_ok 二击出局的「第二击」。
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: REPLAY_URL, egress: REPLAY_EGRESS }))
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7893", egress: "fresh-ip" }))
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7896", egress: "next-ip" })); // 第二击上报的回包
    fetchMock
      .mockResolvedValueOnce(rateLimited()) // 重放 429
      .mockResolvedValueOnce(stall503()); // 续试再 stall

    const { out, logWarn } = await runStallReplay("continue-stall-strike2");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(503);
    // 第三发 rotateEgress = 二击上报（reason="transport"，failedEgress=续试死掉的出口）
    expect(rotateMock).toHaveBeenCalledTimes(3);
    expect(rotateMock.mock.calls[2][0]).toBe("transport");
    expect(rotateMock.mock.calls[2][1].failedEgress).toBe("fresh-ip");
    expect(warned(logWarn, "2nd strike reported")).toBe(true);
  });

  it("still continues on already_retired same-port (egress moved), unaffected by blacklist (fix C)", async () => {
    // already_retired = 失败出口已被换走，同口重连即新出口。黑名单不许误伤它。
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: REPLAY_URL, egress: REPLAY_EGRESS }))
      .mockResolvedValueOnce(rotateOk({ url: null, egress: null, reason: "already_retired", activeEgress: "moved-ip" }));
    fetchMock
      .mockResolvedValueOnce(rateLimited()) // 重放 429
      .mockResolvedValueOnce(ok()); // 同口重连新出口 200

    const { out, logWarn } = await runStallReplay("already-retired-continue");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    expect(warned(logWarn, "no sacrifice")).toBe(true);
    expect(warned(logWarn, "already died in-request")).toBe(false);
  });
});
