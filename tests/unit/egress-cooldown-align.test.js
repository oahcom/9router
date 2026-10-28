import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.EGRESS_MAX_COOLDOWN_MS = "86400000";
  process.env.EGRESS_COOLDOWN_ALIGN_HOUR = "8";
});

import { getEgressCooldown, markEgressCooling, resetEgressState } from "../../open-sse/utils/egress.js";

const DIRECT = { id: "direct:203.0.113.7", kind: "direct", confirmed: true };

describe("egress cooldown alignment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEgressState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parks a cooled direct egress until the next local 08:00", () => {
    vi.setSystemTime(new Date(2026, 9, 28, 19, 7, 0, 0));
    const entry = markEgressCooling(DIRECT, 46_171 * 1000);
    expect(entry).not.toBeNull();
    const until = new Date(entry.until);
    expect(until.getDate()).toBe(29);
    expect(until.getHours()).toBe(8);
    expect(until.getMinutes()).toBe(0);
    // 19:07 -> next 08:00 is 12h53m, longer than the 46_171s hint.
    expect(entry.retryAfterMs).toBe(12 * 3600 * 1000 + 53 * 60 * 1000);
  });

  it("does not jump a whole day when 08:00 is still ahead today", () => {
    vi.setSystemTime(new Date(2026, 9, 29, 7, 0, 0, 0));
    const entry = markEgressCooling(DIRECT, 1000);
    const until = new Date(entry.until);
    expect(until.getDate()).toBe(29);
    expect(until.getHours()).toBe(8);
    expect(entry.retryAfterMs).toBe(3600 * 1000);
  });

  it("never shortens a hint that outlives the aligned hour", () => {
    vi.setSystemTime(new Date(2026, 9, 28, 19, 0, 0, 0));
    const entry = markEgressCooling(DIRECT, 30 * 3600 * 1000);
    expect(entry.retryAfterMs).toBe(24 * 3600 * 1000);
  });

  it("still refuses to cool fixed proxy egresses", () => {
    vi.setSystemTime(new Date(2026, 9, 28, 19, 0, 0, 0));
    const proxy = { id: "proxy:abc", kind: "proxy", confirmed: true };
    expect(markEgressCooling(proxy, 60_000)).toBeNull();
    expect(getEgressCooldown(proxy)).toBeNull();
  });
});
