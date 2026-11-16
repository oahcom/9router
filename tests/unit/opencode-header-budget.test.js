import { describe, expect, it } from "vitest";

import { resolveHeaderTimeoutMs } from "../../open-sse/utils/opencodeTransport.js";
import { OPENCODE_TRANSPORT_CONFIG } from "../../open-sse/config/runtimeConfig.js";

/**
 * 首字节预算的两档语义。
 *
 * 2026-11-16 裁决（主人）：每个 header-timeout 从本发起算、同一把短尺——
 * 基线 10s（48h 定标 <50KB 桶 p90=7.5s，只误杀最慢 4%）+ 每 500KB 25s 保险
 * （>550KB 桶 p99=40.7s 由缩放兜住），封顶 55s。45s 重放地板取消：地板曾让
 * trap 线（24KB）首发挂 20.7s + 重放白挂 45s 后照样 503（wi159ez4h 实测）。
 * 历史语义（20s 快判 + 45s 重放多等）见 git 前史；env 仍可单独拉高重放预算。
 */
describe("resolveHeaderTimeoutMs", () => {
  it("非流式不设上限", () => {
    expect(resolveHeaderTimeoutMs(false, false)).toBe(0);
    expect(resolveHeaderTimeoutMs(false, true)).toBe(0);
  });

  it("首次尝试用 10s 快判", () => {
    expect(resolveHeaderTimeoutMs(true, false)).toBe(
      OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs,
    );
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs).toBe(10 * 1000);
  });

  it("换线重放与首发同尺（每 attempt 新时钟，45s 地板已取消）", () => {
    expect(resolveHeaderTimeoutMs(true, true)).toBe(
      resolveHeaderTimeoutMs(true, false),
    );
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBe(10 * 1000);
  });

  it("重放预算必须留在 base 的 60s 连接超时以内", () => {
    // 超过它，base 的 connectCtrl 会先 abort，45s 这个数字就形同虚设；
    // 而且失败时客户端要白等满 60s 才拿到 503。
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBeLessThan(60 * 1000);
    // 2026-11-16 起允许相等（同尺）：
    expect(OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs).toBeGreaterThanOrEqual(
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
    expect(base).toBe(10 * 1000);
    expect(per).toBe(25 * 1000);
    // 必须留在 base 的 60s 连接超时以内，否则 connectCtrl 先 abort。
    expect(max).toBeLessThan(60 * 1000);
  });

  it("0 字节 / 未知体量仍是 10s 快判", () => {
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

  it("重放取 max(首次预算, 重放基线)，默认同尺且不超过 max", () => {
    const replay = OPENCODE_TRANSPORT_CONFIG.headerTimeoutReplayMs;
    expect(replay).toBe(10 * 1000); // 2026-11-16：45s 地板取消

    // 同尺：重放预算 = 首发预算（每个 attempt 从本发起算同一把尺）。
    expect(resolveHeaderTimeoutMs(true, true, 0)).toBe(
      resolveHeaderTimeoutMs(true, false, 0),
    );
    expect(resolveHeaderTimeoutMs(true, true, 40 * KB)).toBe(
      resolveHeaderTimeoutMs(true, false, 40 * KB),
    );

    // 大 body：重放跟着首发的更大预算走（900KB → 10s + 1.8*25s = 55s）。
    const first900 = resolveHeaderTimeoutMs(true, false, 900 * KB);
    expect(resolveHeaderTimeoutMs(true, true, 900 * KB)).toBe(first900);

    // 封顶仍生效。
    expect(resolveHeaderTimeoutMs(true, true, 50 * MB)).toBe(max);
    expect(resolveHeaderTimeoutMs(true, true, 50 * MB)).toBeLessThan(60 * 1000);
  });
});
