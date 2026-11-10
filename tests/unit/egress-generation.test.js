// 按端口分账的 generation：一条线的 socket 挂了，不该让另外 5 个端口的
// 健康连接池一起重建；旧的「无参全局 bump」语义必须原样保留。
import { beforeEach, describe, expect, it } from "vitest";
import {
  bumpEgressGeneration,
  generationFor,
  egressGenerationSnapshotForTest,
  resetEgressGenerationForTest,
} from "../../open-sse/utils/egressGeneration.js";

const P0 = "http://127.0.0.1:7890";
const P3 = "http://127.0.0.1:7893";

beforeEach(() => resetEgressGenerationForTest());

describe("per-port egress generation", () => {
  it("bumping one port leaves the other ports alone", () => {
    const before0 = generationFor(P0);
    const before3 = generationFor(P3);
    bumpEgressGeneration(P0, { force: true });
    expect(generationFor(P0)).not.toBe(before0);
    expect(generationFor(P3)).toBe(before3);
    expect(egressGenerationSnapshotForTest().perPort["7890"]).toBe(1);
    expect(egressGenerationSnapshotForTest().perPort["7893"]).toBeUndefined();
  });

  it("a no-arg bump keeps the legacy global behaviour (all ports move)", () => {
    const before0 = generationFor(P0);
    const before3 = generationFor(P3);
    bumpEgressGeneration();
    expect(generationFor(P0)).not.toBe(before0);
    expect(generationFor(P3)).not.toBe(before3);
    expect(egressGenerationSnapshotForTest().globalGen).toBe(1);
  });

  it("merges a burst of concurrent failures on the same port", () => {
    const g0 = generationFor(P0);
    bumpEgressGeneration(P0, { now: 10_000 });
    const g1 = generationFor(P0);
    expect(g1).not.toBe(g0);
    // 同一批并发失败在 1s 窗口内合并；重试读的是「当前」generation，
    // 所以节流不会让任何请求骑回旧池。
    bumpEgressGeneration(P0, { now: 10_400 });
    expect(generationFor(P0)).toBe(g1);
    bumpEgressGeneration(P0, { now: 11_200 });
    expect(generationFor(P0)).not.toBe(g1);
    expect(egressGenerationSnapshotForTest().perPort["7890"]).toBe(2);
  });

  it("force bypasses the burst window (used by /slots subscription)", () => {
    const g0 = generationFor(P0);
    bumpEgressGeneration(P0, { now: 20_000 });
    bumpEgressGeneration(P0, { now: 20_010, force: true });
    expect(egressGenerationSnapshotForTest().perPort["7890"]).toBe(2);
    expect(generationFor(P0)).not.toBe(g0);
  });

  it("direct / malformed proxy urls never throw", () => {
    expect(() => generationFor(null)).not.toThrow();
    expect(() => generationFor("not-a-url")).not.toThrow();
    expect(() => bumpEgressGeneration("not-a-url")).not.toThrow();
  });
});
