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

/**
 * 首字节预算按请求体字节数缩放。
 *
 * 线上形状：成功请求的 300–600KB 桶 TTFT p90=27.9s，固定 20s 判死 → 换线 →
 * 重放 → 仍是同一出口 → 503。预算必须跟着体量走，但小 body 仍要快判。
 */
describe("resolveHeaderTimeoutMs — body-size scaling", () => {
  const base = OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs;
  const per = OPENCODE_TRANSPORT_CONFIG.headerTimeoutPer500kbMs;
  const max = OPENCODE_TRANSPORT_CONFIG.headerTimeoutMaxMs;
  const KB = 1024;
  const MB = 1024 * KB;

  it("配置值符合设计", () => {
    expect(base).toBe(20 * 1000);
    expect(per).toBe(15 * 1000);
    // 必须留在 base 的 60s 连接超时以内，否则 connectCtrl 先 abort。
    expect(max).toBeLessThan(60 * 1000);
  });

  it("0 字节 / 未知体量仍是 20s 快判", () => {
    expect(resolveHeaderTimeoutMs(true, false, 0)).toBe(base);
    expect(resolveHeaderTimeoutMs(true, false)).toBe(base);
    expect(resolveHeaderTimeoutMs(true, false, -1)).toBe(base);
    expect(resolveHeaderTimeoutMs(true, false, Number.NaN)).toBe(base);
  });

  it("小 body 不放大（1KB / 40KB）", () => {
    expect(resolveHeaderTimeoutMs(true, false, 1 * KB)).toBe(base + per * (1 * KB / (500 * KB)));
    expect(resolveHeaderTimeoutMs(true, false, 40 * KB)).toBeLessThan(base + 5000);
  });

  it("300KB / 600KB / 900KB 按比例增长且能盖住实测 TTFT", () => {
    const t300 = resolveHeaderTimeoutMs(true, false, 300 * KB);
    const t600 = resolveHeaderTimeoutMs(true, false, 600 * KB);
    const t900 = resolveHeaderTimeoutMs(true, false, 900 * KB);

    expect(t300).toBeCloseTo(base + per * 0.6, 5);
    expect(t600).toBeCloseTo(base + per * 1.2, 5);
    expect(t900).toBeCloseTo(base + per * 1.8, 5);
    expect(t600).toBeGreaterThan(t300);
    expect(t900).toBeGreaterThan(t600);
    // 300–600KB 桶的 p90 TTFT 是 27.9s，预算必须超过它。
    expect(t600).toBeGreaterThan(27_900);
  });

  it("超大 body 封顶在 max，不越 base 的 60s 连接超时", () => {
    expect(resolveHeaderTimeoutMs(true, false, 3 * MB)).toBe(max);
    expect(resolveHeaderTimeoutMs(true, false, 50 * MB)).toBe(max);
    expect(resolveHeaderTimeoutMs(true, false, 50 * MB)).toBeLessThan(60 * 1000);
  });

  it("非流式任何体量都不设限", () => {
    expect(resolveHeaderTimeoutMs(false, false, 0)).toBe(0);
    expect(resolveHeaderTimeoutMs(false, false, 5 * MB)).toBe(0);
    expect(resolveHeaderTimeoutMs(false, true, 5 * MB)).toBe(0);
  });

  it("重放取 max(首次预算, 45s)，且不超过 max", () => {
    const replay = OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs;
    expect(replay).toBe(45 * 1000);

    // 小 body：重放走 45s 下限（原有语义）。
    expect(resolveHeaderTimeoutMs(true, true, 0)).toBe(replay);
    expect(resolveHeaderTimeoutMs(true, true, 40 * KB)).toBe(replay);

    // 大 body：首次预算已经超过 45s，重放要跟着更大的那份，不能被 45s 拉回去。
    // 900KB → 20s + 1.8*15s = 47s > 45s，满足“首次超过重放下限”。
    const first900 = resolveHeaderTimeoutMs(true, false, 900 * KB);
    expect(first900).toBeGreaterThan(replay);
    expect(resolveHeaderTimeoutMs(true, true, 900 * KB)).toBe(first900);

    // 封顶仍生效。
    expect(resolveHeaderTimeoutMs(true, true, 50 * MB)).toBe(max);
    expect(resolveHeaderTimeoutMs(true, true, 50 * MB)).toBeLessThan(60 * 1000);
  });
});
