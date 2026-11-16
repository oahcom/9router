/**
 * 契约测试：stall 收场的 fresh-in-hand 续试（2026-11-16 主人「有没有走到兜底」复盘）。
 *
 * 复盘事实：新预算（11.2s）上线后 95 分钟 16 条合成 503，第七闸口兜底 0 次触发
 * （触发条件挂在 429 收场，stall 收场永远走不到）；双杀弃单那一刻 daemon 刚换出
 * 新线（2nd-strike rotate switched=true）却被「no second replay」丢掉。
 * 责任改动点：60ed7ad7（P1 第二击只上报不重试）+ 5ac82cf3（修 B 同款收手）。
 *
 * 收益账（2026-11-16 14:52-16:29 生产 57 例）：
 *   同线重放（rotate 无新线）  4/31 救回 = 13%，13 例双杀主力
 *   真换线重放                11/22 = 50%
 *   「rotate 没换线就不重放」（停滞即换线）会推翻「绝不再重放/declined 保同线
 *   重放/无闸口 429 合理漏出」复盘契约，留主人拍板——本文件只锁 fresh-line 续试。
 *
 * 锁四个行为：
 *   D1 同线重放又 stall -> 二击上报拿新线 -> fresh-line continue 救回（wiy7o8i3f 全链）
 *   D2 二击也无新线 -> 不续试，replay synthetic 503 按原样收场
 *   D3 rotate 真换线 -> 重放照旧（50% 档）；再 stall 后二击新线继续救
 *   D4 二击回指死线 -> 不续试（A2 同口径），只留二击上报
 *   D5 二击落池闸节点（daemon 第七闸口）-> 同样续试（兜底对 stall 收场生效）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock, egressMock,
} = vi.hoisted(() => {
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
    providerSessionId: "conv-sfc-" + text,
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    reqId: "sfc-" + text,
    usedCredentials: {},
  };
}

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

describe("stall fresh-line continue (2026-11-16 zero-503 rescue)", () => {
  it("D1 rescues the same-line double-kill via 2nd-strike fresh line", async () => {
    // wiy7o8i3f 全链：首发 stall -> rotate line_ok 不换线 -> 同线重放再挂 ->
    // 旧代码弃单（手里 SJC-179 新线已到手）。新代码二击换线后续试救回。
    rotateMock
      .mockResolvedValueOnce(rotateOk({ reason: "line_ok" })) // 首次：无新线，同线重放
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7893", egress: "sjc-ip" })); // 二击：真新线
    fetchMock
      .mockResolvedValueOnce(stall503()) // 同线重放又挂（旧双杀点）
      .mockResolvedValueOnce(ok()); // fresh-line continue 救回

    const { out, logWarn } = await runStallReplay("d1-replay-then-rescue");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    expect(warned(logWarn, "2nd strike reported")).toBe(true);
    expect(warned(logWarn, "fresh-line continue")).toBe(true);
  });

  it("D2 sacrifices with the replay stall 503 when the 2nd strike has no fresh line", async () => {
    rotateMock
      .mockResolvedValueOnce(rotateOk({ reason: "line_ok" })) // 首次：无新线
      .mockResolvedValueOnce(rotateOk({ reason: "line_ok" })); // 二击：仍无新线
    fetchMock.mockResolvedValueOnce(stall503()); // 同线重放挂

    const { out, logWarn } = await runStallReplay("d2-no-fresh-sacrifice");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(503);
    expect(out.response.headers.get("x-transport-error-type")).toBe("synthetic");
    expect(warned(logWarn, "2nd strike reported")).toBe(true);
    expect(warned(logWarn, "fresh-line continue")).toBe(false);
    expect(warned(logWarn, "no second replay (no fresh line in hand)")).toBe(true);
  });

  it("D3 keeps the rotated-line replay (50% lane) and rescues after a second stall", async () => {
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: REPLAY_URL, egress: REPLAY_EGRESS })) // 首次：真换线
      .mockResolvedValueOnce(rotateOk({ url: "http://127.0.0.1:7896", egress: "next-ip" })); // 二击
    fetchMock
      .mockResolvedValueOnce(stall503()) // 换线重放也挂
      .mockResolvedValueOnce(ok()); // fresh-line continue 救回

    const { out, logWarn } = await runStallReplay("d3-replay-then-rescue");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    expect(warned(logWarn, "skip same-line replay")).toBe(false);
    expect(warned(logWarn, "replay result")).toBe(true);
    expect(warned(logWarn, "fresh-line continue")).toBe(true);
  });

  it("D4 sacrifices only after the 2nd strike points back at a dead line", async () => {
    rotateMock
      .mockResolvedValueOnce(rotateOk({ url: REPLAY_URL, egress: REPLAY_EGRESS })) // 首次：真换线
      .mockResolvedValueOnce(rotateOk({ url: DEAD_URL, egress: DEAD_EGRESS })); // 二击：回指死线
    fetchMock.mockResolvedValueOnce(stall503()); // 重放挂

    const { out, logWarn } = await runStallReplay("d4-dead-line-no-continue");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(503);
    expect(warned(logWarn, "2nd strike reported")).toBe(true);
    expect(warned(logWarn, "fresh-line continue")).toBe(false);
    expect(warned(logWarn, "no second replay (no fresh line in hand)")).toBe(true);
  });

  it("D5 continues on the pool-node gate (daemon 7th-gate fallback) for stall outcomes", async () => {
    // 兜底面：daemon 常规候选为空时自动落第七闸口（kind=proxy, :7897, 节点 tag）。
    // 旧代码 stall 收场走不到兜底（触发条件挂在 429）；新代码同一收口接住。
    rotateMock
      .mockResolvedValueOnce(rotateOk({ reason: "line_ok" })) // 首次：无新线
      .mockResolvedValueOnce(rotateOk({ node: "pool-7", url: "http://127.0.0.1:7897" })); // 二击：池闸节点
    fetchMock
      .mockResolvedValueOnce(stall503()) // 同线重放挂
      .mockResolvedValueOnce(ok()); // 池闸续试救回

    const { out, logWarn } = await runStallReplay("d5-pool-node-gate");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    expect(warned(logWarn, "fresh-line continue on pool-7")).toBe(true);
  });
});
