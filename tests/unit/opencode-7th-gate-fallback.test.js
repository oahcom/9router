import { beforeEach, describe, expect, it, vi } from "vitest";

// 第七闸口兜底（give-up -> 7th-gate fallback）可达性契约测试。
// 背景（2026-11-15 复盘改动点①）：兜底条件曾写成 attemptResult === null（永假），
// 12 小时 0 触发无人发现。本文件锁三件事：
//   1. give-up 且池闸没试过 → 兜底必须出场（日志文案 give-up -> 7th-gate 是哨兵 grep 锚点，双向锁）
//   2. 池闸已经试过 → 不重复打（D14 1-attempt budget）
//   3. already_retired give-up（出口卡死、egressStillCurrent veto 拒绝同址重试）→ 兜底同样必须出场
//   4. 兜底拿到的非 429 结果必须被采纳；仍 429 则维持牺牲结论

const { fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock, egressMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
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

function gatePool() {
  return {
    proxyPoolId: "solo",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://127.0.0.1:7897",
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

async function run(text, opts = {}) {
  const executor = getExecutor("opencode");
  const logWarn = vi.fn();
  const result = await executor.execute({
    model: MODEL,
    body: body(text),
    stream: false,
    credentials: { rawHeaders: {} },
    clientTool: "claude",
    proxyOptions: opts.pool || gatePool(),
    providerSessionId: "conv-fb-" + text,
    log: { warn: logWarn, debug: vi.fn(), info: vi.fn() },
    reqId: "fb" + text,
  });
  return { result, logWarn };
}

function warned(logWarn, needle) {
  return logWarn.mock.calls.some((args) =>
    args.some((a) => typeof a === "string" && a.includes(needle)),
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
  resetEgressState();
});

describe("7th-gate fallback reachability", () => {
  it("fires at give-up when the pool gate was never tried", async () => {
    // 首发 429 -> 换线环试一条新端口（也 429）-> 记账换线回「无新线」-> give-up
    // -> 兜底必须出场：要到池节点 -> 打最后一发 -> 200 被采纳。
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());
    rotateMock
      // 初始 asip 记账+换线：给一条新端口
      .mockResolvedValueOnce({
        switched: true,
        switchedAt: Date.now(),
        reason: "ok",
        switchToUrl: "http://127.0.0.1:7896",
        switchToNode: null,
        switchToEgress: "egress-b",
        activeEgress: null,
        lineChanged: true,
      })
      // 环内记账：无新线（canContinue=false -> give-up）
      .mockResolvedValueOnce({
        switched: false,
        restartRequired: false,
        switchToUrl: null,
        switchToNode: null,
        switchToEgress: null,
        activeEgress: null,
        switchedAt: 0,
        reason: "no_slot",
      })
      // 兜底要线：池节点
      .mockResolvedValueOnce({
        switched: true,
        restartRequired: false,
        switchToUrl: "http://127.0.0.1:7897",
        switchToPool: "slot-7",
        switchToNode: "pool-node-9",
        switchToEgress: null,
        activeEgress: null,
        switchedAt: Date.now(),
        reason: "ok",
      });

    const { result, logWarn } = await run("fb-giveup");

    expect(fetchMock).toHaveBeenCalledTimes(3); // 首发 + 环内重试 + 兜底
    expect(warned(logWarn, "give-up -> 7th-gate")).toBe(true); // 哨兵 grep 锚点（双向锁）
    expect(result.response.status).toBe(200); // 兜底结果被采纳
  });

  it("does not fire when the pool gate was already tried in the loop", async () => {
    // 环内已经打过池节点（1-attempt budget）-> 兜底不得重复打池闸。
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited());
    rotateMock
      .mockResolvedValueOnce({
        switched: true,
        switchedAt: Date.now(),
        reason: "ok",
        switchToUrl: "http://127.0.0.1:7897",
        switchToPool: "slot-7",
        switchToNode: "pool-node-2",
        switchToEgress: null,
        activeEgress: null,
        lineChanged: true,
      })
      // 环内记账（给什么不重要，池闸 hop 后会 break）
      .mockResolvedValueOnce({
        switched: false,
        restartRequired: false,
        switchToUrl: null,
        switchToNode: null,
        switchToEgress: null,
        activeEgress: null,
        switchedAt: 0,
        reason: "no_slot",
      });

    const { result, logWarn } = await run("fb-pool-tried");

    expect(fetchMock).toHaveBeenCalledTimes(2); // 首发 + 池闸 hop，无兜底
    expect(warned(logWarn, "give-up -> 7th-gate")).toBe(false);
    expect(result.response.status).toBe(429);
  });

  it("fires on an already_retired give-up (stuck egress is the escape case)", async () => {
    // 出口卡死在被烧地址：egressStillCurrent veto 拒绝同址重试 -> 环一发都不发就 give-up
    // -> attempt.reason === 'already_retired' 不许挡住兜底（2026-11-15 复盘：草稿的排除是错的）。
    egressMock.mockResolvedValue({ egress: "1.2.3.4", since: null });
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());
    rotateMock
      .mockResolvedValueOnce({
        switched: false,
        restartRequired: false,
        switchToUrl: null,
        switchToNode: null,
        switchToEgress: "1.2.3.4",
        activeEgress: "1.2.3.4", // 与报障地址相同 -> egressStillCurrent veto
        switchedAt: 0,
        reason: "already_retired",
      })
      // 兜底要线：池节点
      .mockResolvedValueOnce({
        switched: true,
        restartRequired: false,
        switchToUrl: "http://127.0.0.1:7897",
        switchToPool: "slot-7",
        switchToNode: "pool-node-5",
        switchToEgress: null,
        activeEgress: null,
        switchedAt: Date.now(),
        reason: "ok",
      });

    const { result, logWarn } = await run("fb-stuck-egress");

    expect(fetchMock).toHaveBeenCalledTimes(2); // 首发（被 veto 挡住不重试）+ 兜底
    expect(warned(logWarn, "give-up -> 7th-gate")).toBe(true);
    expect(result.response.status).toBe(200);
  });

  it("keeps the sacrifice verdict when the fallback attempt is also 429", async () => {
    // 兜底打了但仍是 429 -> 不采纳，维持牺牲结论（不无限兜）。
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited()); // 兜底也 429
    rotateMock
      .mockResolvedValueOnce({
        switched: true,
        switchedAt: Date.now(),
        reason: "ok",
        switchToUrl: "http://127.0.0.1:7896",
        switchToNode: null,
        switchToEgress: "egress-b",
        activeEgress: null,
        lineChanged: true,
      })
      .mockResolvedValueOnce({
        switched: false,
        restartRequired: false,
        switchToUrl: null,
        switchToNode: null,
        switchToEgress: null,
        activeEgress: null,
        switchedAt: 0,
        reason: "no_slot",
      })
      .mockResolvedValueOnce({
        switched: true,
        restartRequired: false,
        switchToUrl: "http://127.0.0.1:7897",
        switchToPool: "slot-7",
        switchToNode: "pool-node-9",
        switchToEgress: null,
        activeEgress: null,
        switchedAt: Date.now(),
        reason: "ok",
      });

    const { result, logWarn } = await run("fb-still-429");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warned(logWarn, "give-up -> 7th-gate")).toBe(true);
    expect(result.response.status).toBe(429);
  });

  it("retries a cross-port line even when the reply's active_egress is the failed one", async () => {
    // 跨端口换线时 daemon 回包的 active_egress 是**原端口**那条线的地址，不是目标
    // 端口的出口。旧实现无条件回退到它 -> targetEgress === attemptEgress -> 判
    // 「原地打转」白拒一发（2026-11-15 03:55 wgtsasri7：switch_to_url=:7892 却拿
    // :7894 的 IP 判重复，5 发只打 2 发就 break）。跨端口必须照打：出口身份只有
    // 同端口（原地换线）时 active_egress 才可信。
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());
    rotateMock
      .mockResolvedValueOnce({
        switched: true,
        switchedAt: Date.now(),
        reason: "ok",
        switchToUrl: "http://127.0.0.1:7896",
        switchToNode: null,
        switchToEgress: "egress-b",
        activeEgress: null,
        lineChanged: true,
      })
      // 跨端口换线：没有 switch_to_egress，active_egress 回的是刚打挂的 egress-b
      .mockResolvedValueOnce({
        switched: true,
        restartRequired: false,
        switchToUrl: "http://127.0.0.1:7898",
        switchToNode: null,
        switchToEgress: null,
        activeEgress: "egress-b",
        switchedAt: Date.now(),
        reason: "ok",
      });

    const { result, logWarn } = await run("fb-cross-port");

    expect(fetchMock).toHaveBeenCalledTimes(3); // 首发 + :7896 + :7898，不许白拒
    expect(warned(logWarn, "no new egress")).toBe(false);
    expect(result.response.status).toBe(200);
  });
});
