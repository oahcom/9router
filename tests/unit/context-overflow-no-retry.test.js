// Regression: 400 context_length_exceeded (prompt 超出模型上下文) 被组合层当成
// 「这个成员不行，换下一个」并且客户端自己也循环重发。实测某会话 17:55 起 42 分钟
// 517 条同类 400。真正的原因是同一份超长 body 换谁都得再传一遍 —— 一次上游尝试
// 就够，且必须把上游原错误原样交回客户端（否则客户端看不出真实原因，继续重试）。
import { describe, expect, it, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { isContextOverflowError } from "../../open-sse/config/errorConfig.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function contextOverflow400() {
  return new Response(JSON.stringify({
    error: {
      message: "This model's maximum context length is 65536 tokens. However, you requested 1186139 tokens",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  }), { status: 400, headers: { "content-type": "application/json" } });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isContextOverflowError", () => {
  it("matches OpenAI-style code and wording on 400", () => {
    expect(isContextOverflowError(400, "context_length_exceeded")).toBe(true);
    expect(isContextOverflowError(422, "This model's maximum context length is 8192 tokens")).toBe(true);
  });

  it("matches common alternate wordings", () => {
    expect(isContextOverflowError(400, "prompt is too long: 210000 tokens > 200000 maximum")).toBe(true);
    expect(isContextOverflowError(413, "input is too long")).toBe(true);
    expect(isContextOverflowError(400, "Please reduce the length of the messages")).toBe(true);
  });

  it("does not swallow other 4xx / 5xx", () => {
    expect(isContextOverflowError(400, "Request validation failed")).toBe(false);
    expect(isContextOverflowError(401, "context_length_exceeded")).toBe(false);
    expect(isContextOverflowError(429, "context_length_exceeded")).toBe(false);
    expect(isContextOverflowError(503, "context length exceeded")).toBe(false);
  });
});

describe("checkFallbackError — context overflow", () => {
  it("never cools the account down", () => {
    expect(checkFallbackError(400, JSON.stringify({ code: "context_length_exceeded" }))).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("is not hijacked by unrelated wording in the same body", () => {
    // 上游模板里常混着 "rate limit" / "capacity" 之类的词；正文已经明确是超限，
    // 就不能锁账号（锁了会让其它会话 30s 内拿到这条错误的副本）。
    const body = JSON.stringify({
      error: { message: "context_length_exceeded: reduce the length of the messages", type: "rate_limit_error" },
    });
    expect(checkFallbackError(400, body)).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("still advances for a generic validation 400 (no regression)", () => {
    expect(checkFallbackError(400, "Unsupported parameter: response_format")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });
});

describe("combo — context overflow stops after the first member", () => {
  it("makes exactly one upstream attempt and returns the original 400", async () => {
    const handleSingleModel = vi.fn(async () => contextOverflow400());

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
    });

    // 只打了一个成员：同一份超限 body 不再传给另外两个。
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("provider-a/model-a");

    // 原错误可辨识：状态码与正文都是上游那份，客户端能读到上下文超限。
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.error.message).toContain("maximum context length");
  });

  it("does not advance even when a later member would succeed", async () => {
    const handleSingleModel = vi.fn(async (_b, m) => (
      m === "provider-a/model-a"
        ? contextOverflow400()
        : jsonResponse({ choices: [{ message: { content: "served by b" } }] })
    ));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(400);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("keeps advancing for generic 4xx rejections (no regression)", async () => {
    const handleSingleModel = vi.fn(async (_b, m) => (
      m === "provider-a/model-a"
        ? jsonResponse({ error: { message: "Request validation failed" } }, 400)
        : jsonResponse({ choices: [{ message: { content: "served by b" } }] })
    ));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
