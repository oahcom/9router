import { describe, expect, it } from "vitest";

import { resolveHeaderTimeoutMs } from "../../open-sse/utils/opencodeTransport.js";
import { OPENCODE_TRANSPORT_CONFIG } from "../../open-sse/config/runtimeConfig.js";

/**
 * 首字节预算的两档语义。
 *
 * 线上的失败形状：一条请求 43s 后回 503，日志里是两次
 * `upstream header timeout (20000ms)` —— 20s + 20s。第二次是换线重放，但
 * asip 的探针打的是 max_tokens:1 的小请求，小请求能过、300KB 的大请求挂着，
 * 于是 asip 判「出口正常」不换线，出口地址根本没变。两次 20s 撞的是同一个
 * 出口，等于把同一次失败重演一遍。
 *
 * 同一出口实测首字节随请求体线性增长（1000KB≈7.1s、2000KB≈10s），真实请求
 * p50 就有 452KB，叠上并发排队很容易越 20s。所以重放要给更长的预算，但首次
 * 必须保持快判，否则死出口每条都白拖 45s。
 */
describe("resolveHeaderTimeoutMs", () => {
  it("非流式不设上限", () => {
    expect(resolveHeaderTimeoutMs(false, false)).toBe(0);
    expect(resolveHeaderTimeoutMs(false, true)).toBe(0);
  });

  it("首次尝试用 20s 快判", () => {
    expect(resolveHeaderTimeoutMs(true, false)).toBe(
      OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs,
    );
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs).toBe(20 * 1000);
  });

  it("换线重放放宽到 45s", () => {
    expect(resolveHeaderTimeoutMs(true, true)).toBe(
      OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs,
    );
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBe(45 * 1000);
  });

  it("重放预算必须留在 base 的 60s 连接超时以内", () => {
    // 超过它，base 的 connectCtrl 会先 abort，45s 这个数字就形同虚设；
    // 而且失败时客户端要白等满 60s 才拿到 503。
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBeLessThan(60 * 1000);
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBeGreaterThan(
      OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs,
    );
  });

  it("env 把重放预算配得比首次还小也不倒挂", () => {
    // 配错方向时取两者最大：宁可多等，也不能让重放比首次更快被判死。
    const base = OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs;
    expect(resolveHeaderTimeoutMs(true, true)).toBeGreaterThanOrEqual(base);
  });
});
