// DONE 行尾的 req= 追加断言：带 reqId 时行尾出现 ` · req=xxx`（事后按 id
// 聚合靠 grep `req=([a-z0-9]+)`，与 warn 行同口径）；不带时绝不出现该片段，
// 以免和别的数字/字段混淆。
import { describe, expect, it } from "vitest";
import { formatDoneLine } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("formatDoneLine req= suffix", () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  const latency = { total: 1234 };

  it("appends ` · req=xxx` at the end of the line when reqId is given", () => {
    const line = formatDoneLine({ usage, latency, reqId: "abc12345" });
    expect(line.endsWith(" · req=abc12345")).toBe(true);
    expect(line).toMatch(/req=([a-z0-9]+)$/);
  });

  it("does not append the req= fragment when reqId is missing", () => {
    const line = formatDoneLine({ usage, latency });
    expect(line).not.toContain("req=");
    expect(line.endsWith(" · OUT 5")).toBe(true);
  });
});
