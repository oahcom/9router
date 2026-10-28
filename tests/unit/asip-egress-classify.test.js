import { describe, expect, it } from "vitest";
import { classifyRotateReason } from "../../open-sse/utils/egressClassify.js";

describe("classifyRotateReason", () => {
  it("429 一律按配额换线，不看正文", () => {
    expect(classifyRotateReason(429, "")).toBe("rate429");
    expect(classifyRotateReason(429, "Rate limit exceeded")).toBe("rate429");
    expect(classifyRotateReason(429, undefined)).toBe("rate429");
  });

  it("403 abusive traffic 才算出口信誉问题", () => {
    expect(classifyRotateReason(403, '{"error":"We detected abusive traffic from this IP"}'))
      .toBe("abuse403");
    expect(classifyRotateReason(403, "ABUSIVE TRAFFIC blocked")).toBe("abuse403");
  });

  it("403 FreeTierError 换出口无效，必须放过去", () => {
    expect(classifyRotateReason(403, '{"error":{"type":"FreeTierError"}}')).toBe(null);
    expect(classifyRotateReason(403, "")).toBe(null);
    expect(classifyRotateReason(403, undefined)).toBe(null);
  });

  it("其余状态码与出口无关", () => {
    for (const s of [200, 400, 402, 500, 502, 503, 504]) {
      expect(classifyRotateReason(s, "abusive traffic")).toBe(null);
    }
  });

  it("只认 abusive traffic 短语，不认单个词", () => {
    expect(classifyRotateReason(403, "abusive")).toBe(null);
    expect(classifyRotateReason(403, "traffic")).toBe(null);
  });
});
