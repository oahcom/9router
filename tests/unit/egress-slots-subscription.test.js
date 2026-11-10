// 订阅式感知：9router 拉 /slots 发现某端口挂的出口地址变了，就立刻让该端口
// 的连接池失效 —— 这是 asip 单方面重启隧道时 9router 唯一的知情渠道。
// 地址没变时不能抖动，否则每次刷新都会重建全部连接。
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.ASIP_DISABLED = "0";
  process.env.ASIP_TOKEN_FILE = process.cwd() + "/package.json";
  process.env.ASIP_SOCKET = "/tmp/asip-subscription-test.sock";
  return { slotsRes: {} };
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
      queueMicrotask(() => cb(new FakeRes(h.slotsRes)));
    }
    on(ev, fn) {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    }
    write() {}
    end() {}
    destroy() {}
  }
  return { default: { request: (opts, cb) => new FakeReq(opts, cb) } };
});

const { notePortLine, refreshSlotEgress, resetPortLinesForTest } = await import(
  "../../open-sse/utils/asipRotate.js"
);
const gen = await import("../../open-sse/utils/egressGeneration.js");

const P0 = "http://127.0.0.1:7890";
const P3 = "http://127.0.0.1:7893";

function slots(tag, ip) {
  h.slotsRes = {
    ok: true, active_tag: tag,
    slots: [{ name: "slot-1", port: 7890, tag, egress: ip }],
  };
}

beforeEach(() => {
  resetPortLinesForTest();
  gen.resetEgressGenerationForTest();
});

describe("/slots identity-change subscription", () => {
  it("invalidates the changed port only", async () => {
    notePortLine(P0, "WARP-A", "2a09::1", 1234);
    slots("WARP-B", "2a09::2");
    const before0 = gen.generationFor(P0);
    const before3 = gen.generationFor(P3);

    await refreshSlotEgress();

    expect(gen.generationFor(P0)).not.toBe(before0);
    expect(gen.generationFor(P3)).toBe(before3);
  });

  it("does not churn when the egress is unchanged", async () => {
    notePortLine(P0, "WARP-A", "2a09::1", 1234);
    slots("WARP-A", "2a09::1");
    const before0 = gen.generationFor(P0);
    await refreshSlotEgress();
    expect(gen.generationFor(P0)).toBe(before0);
    expect(gen.egressGenerationSnapshotForTest().perPort["7890"]).toBeUndefined();
  });
});
