import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  return {
    fetchMock: vi.fn(),
    rotateMock: vi.fn(),
    enabledMock: vi.fn(() => true),
    bumpMock: vi.fn(),
    cooldownMock: vi.fn(),
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
  // 执行器按端口取出口身份；mock 里一律「未知」，等价于改动前的 null。
  asipEgressForPort: async () => ({ egress: null, since: null }),
  // 目标端口失败后要把它打进短冷却，否则下一条新请求又选中它。
  markAsipProxyCooling: cooldownMock,
  // 执行器每次请求都会读一次「当前出口地址」，429 时交给 asip 判断是否已被
  // 换走。白盒替换漏了它整个 executeInner 会抛 TypeError。
  currentAsipEgress: () => null,
  currentAsipEgressSince: () => null,
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

function rateLimitedWithRetry(seconds = 43200) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(seconds),
      },
    },
  );
}

function stalled(failure = "header-timeout") {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "UpstreamTransportError" } }),
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
  cooldownMock.mockReset();
  enabledMock.mockReset();
  enabledMock.mockReturnValue(true);
  bumpMock.mockReset();
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
    // 只清 undici dispatcher 不够：Bun sidecar 的 session 是 proxy|generation 分桶的，
    // 换线后不 bump 就等于还骑在旧隧道上（审查发现）。
    expect(bumpMock).toHaveBeenCalledTimes(1);
  });

  it("retries when asip says the 429 tracked a tunnel that was already replaced", async () => {
    // already_retired：asip 没换线，但这条 429 追的地址在请求发出之后被换掉了。
    // switchedAt 是更早的时刻，只看它会当成「没换、不重试」—— 而这条 429 恰好
    // 证明手里这条连接已经骑在一条下线的隧道上，重连一次就能绕开。
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({
      switched: false,
      switchedAt: Date.now() - 60_000,
      reason: "already_retired",
      lineChanged: false,
    });

    const result = await run("retired");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    expect(bumpMock).toHaveBeenCalledTimes(1);
  });

  it("hands asip the egress this request went out on", async () => {
    // 没有这个地址，asip 只能靠时刻回溯猜；带上它是一次查表。
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "too_frequent" });

    await run("passthrough");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    const opts = rotateMock.mock.calls[0][1];
    expect(opts).toHaveProperty("requestStartedAt");
    expect(opts).toHaveProperty("failedEgress");
  });

  it("does not retry when asip declines the rotation", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "too_frequent" });

    const result = await run("declined");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it("does not retry when asip asks for a self-restart", async () => {
    // 旧版 asip 无健康备槽时仍回 reason=ok，并且可能带上一个足以让主分支
    // 判定「换过线」的 switchedAt。可这一刻没有任何可用闸口，1s 后本进程
    // 还要自重启 —— 重试只会打在刚烧掉的原端口上、还撞上进程退出。
    // restartRequired 必须对重试条件一票否决。
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({
      switched: false, switchedAt: Date.now() + 60_000,
      reason: "ok", restartRequired: true,
      lineUnknown: true, switchToUrl: null, lineChanged: false,
    });

    const result = await run("deadgate");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it("does not retry on a stale non-zero switchedAt", async () => {
    // coalesced / too_frequent 会回上一次换线的时间戳：非零，但远早于本次请求。
    // 只看「非零」会误判成换成功，所以 gate 必须比时间。
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: Date.now() - 60_000, reason: "coalesced" });

    const result = await run("stale");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it("bumps the transport generation when asip times out", async () => {
    // 超时 = asip 已经在换、只是没等到回话：这条隧道确实要换了，得让 sidecar 重建。
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "timeout" });

    const result = await run("timeout");

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bumpMock).toHaveBeenCalledTimes(1);
  });

  it("skips asip entirely when rotation is disabled", async () => {
    enabledMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(rateLimited());

    const result = await run("disabled");

    expect(rotateMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it("rotates on a transport stall and retries on the fresh egress", async () => {
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("stall-rotate");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock.mock.calls[0][0]).toBe("transport");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    expect(bumpMock).toHaveBeenCalledTimes(1);
  });

  it("also replays an upstream fetch failure before any response bytes", async () => {
    fetchMock.mockResolvedValueOnce(stalled("upstream-fetch-failed")).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("fetch-failed");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock.mock.calls[0][0]).toBe("transport");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("keeps the fresh-connection retry when asip declines a stall rotation", async () => {
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "no_warm_standby" });

    const result = await run("stall-declined");

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    expect(bumpMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a persistent transport stall to one replay", async () => {
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(stalled());
    rotateMock.mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("stall-persistent");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(503);
  });

  // 回归：把重放改成走 BaseExecutor 之后，429 的标脏/冷却整段不可达，目标出口
  // 在随后几分钟被反复复用。修复后重放 429 必须补一次记账，且只记一次。
  it("accounts the replay 429 on the port that actually carried it", async () => {
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(rateLimitedWithRetry(43200));
    rotateMock
      .mockResolvedValueOnce({
        switched: true,
        switchedAt: Date.now(),
        reason: "ok",
        switchToUrl: "http://127.0.0.1:7896",
        switchToEgress: "2606:slot6::1",
        avoidPortUntil: 0,
      })
      .mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("stall-replay-429");

    expect(result.response.status, "记账不能改变失败结果").toBe(429);
    expect(fetchMock, "只记账、绝不再重放，防止循环").toHaveBeenCalledTimes(2);
    expect(rotateMock).toHaveBeenCalledTimes(2);
    expect(rotateMock.mock.calls[0][0]).toBe("transport");
    expect(rotateMock.mock.calls[1][0]).toBe("rate429");
    const opts = rotateMock.mock.calls[1][1];
    expect(opts.proxyUrl, "必须归因到真正承载这次 429 的目标闸，不是事发闸").toBe("http://127.0.0.1:7896");
    expect(opts.failedEgress).toBe("2606:slot6::1");
    expect(opts.reqId).toBe("solo12345");
    expect(opts.requestStartedAt, "用重放发出时刻，不是原请求时刻").toBeGreaterThan(0);
    expect(opts.retryAfterMs, "上游 Retry-After 必须透传给 asip 写 ban_until").toBe(43200 * 1000);
  });

  it("accounts a retry 429 after asip already rotated instead of only cooling the port", async () => {
    // 2026-11-10 23:11:41 req=watvq3hbz 实测：asip 回 coalesced + switchToUrl，
    // 重试仍 429，但只看到 markAsipProxyCooling，没有 rate429 回流 —— 目标出口
    // 既不标脏也不写 ban_until，60s 后又被选回来。这条用例锁住回流记账。
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(rateLimited());
    rotateMock
      .mockResolvedValueOnce({
        switched: true,
        switchedAt: Date.now(),
        reason: "coalesced",
        switchToUrl: "http://127.0.0.1:7895",
        switchToEgress: "2606:slot5::1",
        avoidPortUntil: 0,
      })
      .mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("retry-429");

    expect(result.response.status, "记账不能改变失败结果").toBe(429);
    expect(fetchMock, "只记账、绝不再重放").toHaveBeenCalledTimes(2);
    expect(rotateMock).toHaveBeenCalledTimes(2);
    expect(rotateMock.mock.calls[0][0]).toBe("rate429");
    expect(rotateMock.mock.calls[1][0], "重试仍 429 必须补一次 rate429 记账").toBe("rate429");
    const opts = rotateMock.mock.calls[1][1];
    expect(opts.proxyUrl, "归因到重试真正走的闸，不是事发闸").toBe("http://127.0.0.1:7895");
    expect(opts.failedEgress).toBe("2606:slot5::1");
    expect(opts.requestStartedAt, "用重试发出时刻").toBeGreaterThan(0);
    expect(cooldownMock, "端口冷却仍然保留").toHaveBeenCalledWith("http://127.0.0.1:7895");
  });

  it("passes the upstream Retry-After on the normal 429 path too", async () => {
    fetchMock.mockResolvedValueOnce(rateLimitedWithRetry(45000)).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("first-429-retry-after");

    expect(result.response.status).toBe(200);
    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock.mock.calls[0][1].retryAfterMs).toBe(45000 * 1000);
  });

  it("does not add an accounting rotation when the replay succeeds", async () => {
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({
      switched: true,
      switchedAt: Date.now(),
      reason: "ok",
      switchToUrl: "http://127.0.0.1:7896",
      switchToEgress: "2606:slot6::1",
      avoidPortUntil: 0,
    });

    const result = await run("stall-replay-ok");

    expect(result.response.status).toBe(200);
    expect(rotateMock, "200 不触发记账，保持原有一次 transport 换线").toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips accounting when asip rotation is disabled", async () => {
    enabledMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(rateLimited());

    const result = await run("stall-replay-429-disabled");

    expect(result.response.status).toBe(429);
    expect(rotateMock, "功能关闭时不额外发 /rotate").toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives the rotated replay a longer header budget", async () => {
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({ switched: true, switchedAt: Date.now(), reason: "ok" });

    const result = await run("stall-budget");

    expect(result.response.status).toBe(200);
    // 首次尝试必须保持快判：不加预算，20s 判死坏出口。
    expect(fetchMock.mock.calls[0][1].replayBudget).toBeUndefined();
    // 重放是「换线后的第二次机会」：asip 常回「出口正常不换线」，出口地址没变，
    // 再用 20s 判死就是把同一次失败重演一遍（实测 43s = 20+20 后 503）。
    expect(fetchMock.mock.calls[1][1].replayBudget).toBe(true);
  });

  it("retries the 429 on the healthy port asip pointed at", async () => {
    // 多端口布局：asip 不再切 selector，而是让这次重试改走另一台 sing-box。
    // 停在原端口重试等于在同一个坏进程上再撞一次。
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({
      switched: true,
      switchedAt: Date.now(),
      reason: "rate429",
      switchToUrl: "http://127.0.0.1:7893",
      switchToEgress: "2606:slot3::1",
      avoidPortUntil: 0,
    });

    const result = await run("switch-port");

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][2].url).toBe("http://127.0.0.1:7893");
    expect(fetchMock.mock.calls[1][2].enabled).toBe(true);
    // 目标端口没报错就不该冷却它。
    expect(cooldownMock).not.toHaveBeenCalled();
  });

  it("retries when asip can only name a port (line_unknown)", async () => {
    // 并发抢锁失败时 asip 不知道该说哪条线，但仍然知道哪台 sing-box 健康。
    // 只看 switched 会白丢一个当场可用的出口。
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());
    rotateMock.mockResolvedValueOnce({
      switched: false,
      switchedAt: 0,
      reason: "coalesced",
      lineUnknown: true,
      switchToUrl: "http://127.0.0.1:7894",
      avoidPortUntil: 0,
    });

    const result = await run("line-unknown");

    expect(result.response.status).toBe(200);
    expect(fetchMock.mock.calls[1][2].url).toBe("http://127.0.0.1:7894");
  });

  it("cools the target port with the local default window", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(rateLimited());
    // 这个时刻属于**原端口**（asip 报的就是它）；目标端口是另一台进程，
    // 不能被挪用，否则可能拿到一个早已过期的截止时间。
    const sourcePortUntil = Date.now() + 12_000;
    rotateMock.mockResolvedValueOnce({
      switched: true,
      switchedAt: Date.now(),
      reason: "rate429",
      switchToUrl: "http://127.0.0.1:7895",
      switchToEgress: "2606:slot5::1",
      avoidPortUntil: sourcePortUntil,
    });

    const result = await run("both-429");

    expect(result.response.status).toBe(429);
    expect(cooldownMock).toHaveBeenCalledWith("http://127.0.0.1:7895");
    expect(cooldownMock).not.toHaveBeenCalledWith(
      "http://127.0.0.1:7895", sourcePortUntil);
  });

  it("retries a stall on a fresh connection when asip is disabled", async () => {
    enabledMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(stalled()).mockResolvedValueOnce(ok());

    const result = await run("stall-disabled");

    expect(rotateMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });
});
