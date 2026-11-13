// 三条修复的接线测试：
//  1. /rotate 不带 reqId 时从请求上下文兜底（transport / proxyFetch 那两条路径）
//  2. 出口身份按端口存，且 /slots 能灌入、过期能刷新（不再拿全局旧值）
//  3. /rotate 回包里的 active_egress 会写回该端口的身份
//
// 用假的 node:http 顶掉 UDS：既能抓到 /rotate 的请求体，又不会真的切生产出口。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // tests/setup.js 会把 ASIP_DISABLED 置 1；测试文件模块在 setup 之后求值，
  // 这里改回 0 才能让 callAsip 真的走到 http.request。
  process.env.ASIP_DISABLED = "0";
  // readToken() 只要读到非空内容即可，token 本身不被校验。
  process.env.ASIP_TOKEN_FILE = process.cwd() + "/package.json";
  process.env.ASIP_SOCKET = "/tmp/asip-fake-test.sock";
  return {
    rotateCalls: [],
    httpCalls: [],
    rotateRes: {},
    slotsRes: {},
  };
});

vi.mock("node:http", () => {
  class FakeRes {
    constructor(payload) {
      this.statusCode = 200;
      this.payload = payload;
      this.handlers = {};
    }
    on(ev, fn) {
      (this.handlers[ev] ||= []).push(fn);
      if (ev === "end") {
        queueMicrotask(() => {
          for (const f of this.handlers.data || []) f(JSON.stringify(this.payload));
          fn();
        });
      }
      return this;
    }
    setEncoding() {}
    resume() {}
  }
  class FakeReq {
    constructor(opts, cb) {
      this.opts = opts;
      this.handlers = {};
      h.httpCalls.push(opts.path);
      queueMicrotask(() => {
        cb(new FakeRes(opts.path === "/slots" ? h.slotsRes : h.rotateRes));
      });
    }
    on(ev, fn) {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    }
    write(body) {
      if (this.opts.path === "/rotate") h.rotateCalls.push(JSON.parse(body));
    }
    end() {}
    destroy() {}
  }
  return { default: { request: (opts, cb) => new FakeReq(opts, cb) } };
});

const {
  rotateEgress,
  notePortLine,
  egressForPort,
  asipEgressForPort,
  refreshSlotEgress,
  resetPortLinesForTest,
} = await import("../../open-sse/utils/asipRotate.js");
const { runWithReqId, currentReqId } = await import(
  "../../open-sse/utils/requestContext.js"
);

const P6 = "http://127.0.0.1:7896";
const P3 = "http://127.0.0.1:7893";
const IP6 = "2a09:bac5:495e:263c::3cf:6c";
const IP3 = "2a09:bac5:a5ff:25a5::3c0:27";

let clock = 0;

beforeEach(() => {
  resetPortLinesForTest();
  h.rotateCalls.length = 0;
  h.httpCalls.length = 0;
  h.rotateRes = {
    reason: "ok", switched: false, switched_at: 0,
    active_tag: "WARP-H2-HKG-10", active_egress: IP6,
    active_egress_since: 1700000000,
  };
  h.slotsRes = {
    slots: [
      { port: 7890, tag: "WARP-H2-GIG-78", egress: "2a09:bac5:1111::1" },
      { port: 7893, tag: "WARP-H2-ORD-11", egress: IP3 },
      { port: 7896, tag: "WARP-H2-HKG-10", egress: IP6 },
    ],
  };
  clock = 1770000000000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reqId 透传：/rotate 不再记成 req=-", () => {
  it("调用方没带 reqId 时从请求上下文兜底", async () => {
    await runWithReqId("req-abc123", () =>
      rotateEgress("transport", { proxyUrl: P6 }));

    expect(h.rotateCalls).toHaveLength(1);
    expect(h.rotateCalls[0].req_id).toBe("req-abc123");
    expect(h.rotateCalls[0].reason).toBe("transport");
  });

  it("不在请求上下文里、也没显式传时，不硬造一个假号", async () => {
    expect(currentReqId()).toBeNull();
    await rotateEgress("transport", { proxyUrl: P3 });
    expect(h.rotateCalls[0].req_id).toBeUndefined();
  });

  it("显式传的 reqId 优先于上下文（记账路径自带号）", async () => {
    await runWithReqId("from-context", () =>
      rotateEgress("rate429", { proxyUrl: P6, reqId: "explicit-id" }));
    expect(h.rotateCalls[0].req_id).toBe("explicit-id");
  });

  it("并发请求各带各的号，不会被覆写成同一个", async () => {
    await Promise.all([
      runWithReqId("req-A", async () => {
        await Promise.resolve();
        return rotateEgress("rate429", { proxyUrl: P6 });
      }),
      runWithReqId("req-B", async () => {
        await Promise.resolve();
        await Promise.resolve();
        return rotateEgress("rate429", { proxyUrl: P3 });
      }),
    ]);
    expect(h.rotateCalls.map((c) => c.req_id).sort()).toEqual(["req-A", "req-B"]);
  });
});

describe("每端口出口身份：按端口存、能刷新、会过期", () => {
  it("rotate 回包的 active_egress 写回发起端口，不污染别的端口", async () => {
    notePortLine("http://127.0.0.1:7895", "WARP-CF-G", "2a09:bac5:dddd::9", 1600);
    await rotateEgress("rate429", { proxyUrl: P6, reqId: "r1" });

    expect(egressForPort(P6)).toEqual({ egress: IP6, since: 1700000000 });
    expect(egressForPort(P3).egress).toBeNull();
    expect(egressForPort("http://127.0.0.1:7895").egress).toBe("2a09:bac5:dddd::9");
  });

  it("/slots 快照按 port 灌进还没记录的端口", async () => {
    const byPort = await refreshSlotEgress();
    expect(h.httpCalls).toContain("/slots");
    expect(byPort.get("7893").egress).toBe(IP3);
    expect(egressForPort(P3).egress).toBe(IP3);
  });

  it("asipEgressForPort 在缓存缺失时主动问一次 /slots", async () => {
    const got = await asipEgressForPort("http://127.0.0.1:7892");
    expect(h.httpCalls).toContain("/slots");
    // 7892 不在假快照里 → 保持未知，而不是拿别的端口地址顶替。
    expect(got).toEqual({ egress: null, tag: null, since: null });
  });

  it("身份过期后被 /slots 的新地址覆盖，since 不沿用旧线", async () => {
    notePortLine(P3, "WARP-H2-OLD", "2a09:bac5:old::1", 1500);
    expect(egressForPort(P3).egress).toBe("2a09:bac5:old::1");

    clock += 31000; // 超过 30s 缓存窗口，asip 期间主动换过线
    const got = await asipEgressForPort(P3);

    expect(h.httpCalls).toContain("/slots");
    expect(got.egress).toBe(IP3);
    expect(got.since).toBeNull(); // 地址变了，旧接入时刻作废
  });

  it("/slots 不可达时宁可报未知，也不拿过期身份去判 already_retired", async () => {
    notePortLine(P3, "WARP-H2-OLD", "2a09:bac5:old::1", 1500);
    h.slotsRes = { error: "no-token" };
    clock += 31000;

    const got = await asipEgressForPort(P3);
    expect(got).toEqual({ egress: null, tag: null, since: null });
  });
});
