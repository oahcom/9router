import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  emitRequestError: vi.fn(),
}));

import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { ollamaBodyToOpenAI } from "../../open-sse/translator/response/ollama-to-openai.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Upstream open issue fixes (Oct 2026)", () => {
  it("Issue #5139: DeepSeek executor converts response_format json_schema to json_object + system schema instruction", () => {
    const exec = new DefaultExecutor("deepseek");
    const out = exec.transformRequest("deepseek-chat", {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Is the sky blue?" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ans",
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
        },
      },
    }, false, {});
    expect(out.response_format).toEqual({ type: "json_object" });
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain('"answer"');
  });

  it("Issue #5125: openaiToClaudeRequest converts image_url inside role:tool messages to Claude image blocks", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const out = openaiToClaudeRequest("claude-sonnet-5-5", {
      messages: [
        { role: "user", content: "take screenshot" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "screenshot", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "Captured:" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
          ],
        },
      ],
    }, false);
    const toolResultMsg = out.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
    expect(toolResultMsg).toBeTruthy();
    const inner = toolResultMsg.content[0].content;
    expect(Array.isArray(inner)).toBe(true);
    expect(inner[0]).toEqual({ type: "text", text: "Captured:" });
    expect(inner[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngBase64 },
    });
  });

  it("Issue #5108: applyThinking preserves explicit budget_tokens on deepseek thinkingFormat", () => {
    const body = applyThinking("openai", "deepseek-v4.1-flash", {
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled", budget_tokens: 16384 },
    }, "openai-compatible-chat-test");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  });

  it("Issue #5126: detectRequiredCapabilities and openaiResponsesToOpenAIRequest handle images inside function_call_output", () => {
    const responsesBody = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
        { type: "function_call", call_id: "fc_1", name: "view_img", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "fc_1",
          output: [
            { type: "input_text", text: "image loaded" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    };
    const caps = detectRequiredCapabilities(responsesBody);
    expect(caps.has("vision")).toBe(true);

    const chatBody = openaiResponsesToOpenAIRequest("gpt-5", responsesBody, false, {});
    const toolMsg = chatBody.messages.find((m) => m.role === "tool");
    expect(Array.isArray(toolMsg.content)).toBe(true);
    expect(toolMsg.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA", detail: "auto" },
    });
  });

  it("Issue #5137: ollamaBodyToOpenAI handles body.response when message.content is missing", () => {
    const body = ollamaBodyToOpenAI({
      model: "llama3",
      response: "Hello world",
      done: true,
    });
    expect(body.choices[0].message.content).toBe("Hello world");
  });

  it("Issue #5149: createSSEStream preserves prompt_tokens_details and completion_tokens_details on finish chunk", async () => {
    const { Readable } = await import("node:stream");
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":1200,"cache_creation_tokens":300}}}\n\n',
      'data: [DONE]\n\n',
    ];
    let chunkIndex = 0;
    const source = new Readable({
      read() {
        if (chunkIndex < chunks.length) {
          this.push(chunks[chunkIndex++]);
        } else {
          this.push(null);
        }
      },
    });

    const stream = createSSEStream({
      mode: "passthrough",
      provider: "test",
      model: "test-model",
      body: { messages: [] },
    });

    const reader = source.pipeThrough(stream).getReader();
    const allChunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allChunks.push(new TextDecoder().decode(value));
    }

    const full = allChunks.join("");
    const dataLines = full
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const finalChunk = dataLines.find((c) => c.choices?.[0]?.finish_reason === "stop");
    expect(finalChunk).toBeTruthy();
    expect(finalChunk.usage.prompt_tokens_details).toEqual({
      cached_tokens: 1200,
      cache_creation_tokens: 300,
    });
  });
});