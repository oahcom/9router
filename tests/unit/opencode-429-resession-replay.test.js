import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resessionReplayEnabled,
  makeResessionCredentials,
  isResessionReplaySuccess,
  OpenCodeExecutor,
} from "../../open-sse/executors/opencode.js";

const { fetchMock, rotateMock, enabledMock, bumpMock, cooldownMock, egressMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  // 复测默认关闭，这里显式打开：下面的 execute 级用例要走 replay 路径。
  process.env.OPENCODE_429_RESESSION_REPLAY = "on";
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

import { resetEgressState } from "../../open-sse/utils/egress.js";

const SESSION = "_opencodeSession";
const ENV = "OPENCODE_429_RESESSION_REPLAY";
const CURRENT = "ses_aaaaaaaaaaaaAAAAAAAAAAAAAA";
// OPENCODE_SESSION_RE = ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
const NATIVE_SESSION = "ses_0123456789abcdefghijklmnop";

describe("P0-3 / 开关：默认绝不改生产行为", () => {
  it("没配就关", () => {
    expect(resessionReplayEnabled({})).toBe(false);
    expect(resessionReplayEnabled({ [ENV]: undefined })).toBe(false);
  });

  it("只认 on / 1 / true，大小写与空格容错", () => {
    for (const v of ["on", "1", "true", " ON ", "True", " 1 "]) {
      expect(resessionReplayEnabled({ [ENV]: v }), String(v)).toBe(true);
    }
  });

  it("其它值（含写错的实验开关）一律关 —— 打错字不能静默打开", () => {
    for (const v of ["off", "all", "borrowed", "yes", "y", "", "0", "2", null]) {
      expect(resessionReplayEnabled({ [ENV]: v }), String(v)).toBe(false);
    }
  });
});

describe("P0-3 / 判据：只有 2xx 才算首发是误判", () => {
  it("2xx 才算通过", () => {
    for (const s of [200, 201, 204, 299]) {
      expect(isResessionReplaySuccess(s), String(s)).toBe(true);
    }
  });

  it("403 / 5xx / 429 / 无响应 一律不算通过，必须落回报障路径", () => {
    for (const s of [403, 429, 500, 502, 503, 199, 300, null, undefined, "200"]) {
      expect(isResessionReplaySuccess(s), String(s)).toBe(false);
    }
  });
});

describe("P0-3 / 凭据：必须真的换过 session 才算复测", () => {
  it("返回新对象，session 与首发不同，其余字段原样，且不改首发凭据", () => {
    const providerSpecificData = { a: 1 };
    const prepared = {
      apiKey: "sk-test",
      providerSpecificData,
      [SESSION]: CURRENT,
    };
    const next = makeResessionCredentials(prepared);

    expect(next).not.toBeNull();
    expect(next).not.toBe(prepared);
    expect(next[SESSION]).not.toBe(CURRENT);
    expect(next.apiKey).toBe("sk-test");
    expect(next.providerSpecificData).toBe(providerSpecificData);
    expect(prepared[SESSION]).toBe(CURRENT);
  });

  it("多次调用都能换出不同 session（15 选 1 撞车时内部会重抽）", () => {
    const prepared = { apiKey: "sk-test", [SESSION]: CURRENT };
    for (let i = 0; i < 30; i += 1) {
      expect(makeResessionCredentials(prepared)?.[SESSION]).not.toBe(CURRENT);
    }
  });

  it("native session（调用方显式指定）不能换，返回 null", () => {
    const prepared = {
      rawHeaders: { "x-opencode-session": NATIVE_SESSION },
      [SESSION]: CURRENT,
    };
    expect(makeResessionCredentials(prepared)).toBeNull();
  });

  it("缺 session / 非对象一律 null，不伪造复测", () => {
    expect(makeResessionCredentials({ apiKey: "x" })).toBeNull();
    expect(makeResessionCredentials({})).toBeNull();
    expect(makeResessionCredentials(null)).toBeNull();
    expect(makeResessionCredentials("x")).toBeNull();
  });
});

// X2：replay 串行挡在 rotateEgress 之前，上游真把额度耗尽时它会一直等到上游
// 回话，直接吃掉 ROTATE_ATTEMPT_BUDGET_MS（25s），换线重试首轮即 budget spent。
// 所以 replay 必须有 8s 硬上限：到点放弃复测、照常报障，把预算留给换线重试。
describe("X2 / replay 硬超时", () => {
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

  function rateLimited() {
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

  // 模拟「上游一直不回话」：不 resolve，只在 signal abort 时以 AbortError 拒绝 ——
  // 与真实 fetch 对 abort 的行为一致（abort 依赖 mock 配合才生效）。
  function hangUntilAborted() {
    return (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    });
  }

  async function runReplay(text, { signal } = {}) {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const executor = new OpenCodeExecutor();
    const result = await executor.execute({
      model: MODEL,
      body: { messages: [{ role: "user", content: text }], tools: [] },
      stream: false,
      credentials: { rawHeaders: {} },
      clientTool: "claude",
      proxyOptions: soloPool(),
      providerSessionId: "replay-" + text,
      log,
      reqId: "replay12345",
      ...(signal ? { signal } : {}),
    });
    return { result, log };
  }

  function warnLines(log) {
    return log.warn.mock.calls.map((call) => call.map(String).join(" "));
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

  it("replay 卡到 8s 硬上限就放弃，走 rotateEgress 报障，并给出 timeout warn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fetchMock.mockResolvedValueOnce(rateLimited()).mockImplementationOnce(hangUntilAborted());
      rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "too_frequent" });

      const pending = runReplay("replay-hang");
      await vi.advanceTimersByTimeAsync(8300);
      const { result, log } = await pending;

      // 首发 + 一次被中断的 replay；超时后照常报障（rate429），没有换线重试。
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.response.status).toBe(429);
      expect(rotateMock).toHaveBeenCalledTimes(1);
      expect(rotateMock.mock.calls[0][0]).toBe("rate429");

      const warns = warnLines(log);
      expect(warns.some((m) => m.includes("429 re-session replay timeout after 8000ms; continue accounting"))).toBe(true);
      // 供预算观测：replay 实际耗时（≈8s）必须被记下来。
      expect(warns.some((m) => /re-session replay took \d+ms \(> 3000ms\); watch rotate budget/.test(m))).toBe(true);
      // AbortError 不能显示成裸 error.message。
      expect(warns.some((m) => m.includes("This operation was aborted"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caller signal 已 abort 时 replay 完全不发起", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    fetchMock.mockResolvedValueOnce(rateLimited());
    rotateMock.mockResolvedValueOnce({ switched: false, switchedAt: 0, reason: "too_frequent" });

    const { result, log } = await runReplay("replay-pre-aborted", { signal: ctrl.signal });

    // 首发照常；replay 直接跳过，第二发上游请求不存在。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
    const warns = warnLines(log);
    expect(warns.some((m) => m.includes("429 re-session replay skipped (caller signal aborted)"))).toBe(true);
  });
});
