import { describe, expect, it } from "vitest";

import { newRequestId } from "../../src/sse/utils/logger.js";

describe("request id", () => {
  it("is short, alphanumeric and unique within one millisecond", () => {
    const now = 1_793_188_800_000;
    const a = newRequestId(now);
    const b = newRequestId(now);
    expect(a).toMatch(/^[0-9a-z]{9}$/);
    expect(b).toMatch(/^[0-9a-z]{9}$/);
    expect(a).not.toBe(b);
  });

  it("sorts by time: a later request has a larger prefix", () => {
    const earlier = newRequestId(1_793_188_800_000).slice(0, 7);
    const later = newRequestId(1_793_188_800_500).slice(0, 7);
    expect(later >= earlier).toBe(true);
  });
});
