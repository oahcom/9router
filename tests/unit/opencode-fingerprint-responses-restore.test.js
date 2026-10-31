// Regression: the OpenCode free-tier fingerprint renames every caller tool to a
// neutral alias (get_file -> fn_1kyuucu). On the Responses lane the alias leaked
// back to codex three ways:
//   1. `response.completed` carries the whole response object, so its
//      `output[]` sits one level down under `response` — restoreToolNames only
//      looked at a top-level `output[]` and forwarded fn_1kyuucu verbatim.
//   2. The executor's retry/transport-failover replay runs transformRequest on
//      the same body a second time, aliasing the alias and overwriting the
//      recorded map with {fn_06c90ev -> fn_19omnbq}. Single-hop restore then
//      hands the client the FIRST alias instead of `get_file`.
// codex answers any of those with "unsupported call" and the tool layer is dead.
import { describe, it, expect } from "vitest";

import {
  applyFingerprintTools,
  restoreToolNames,
  takeRenamedToolNames,
} from "../../open-sse/utils/opencodeFingerprint.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const CALLER_TOOL = {
  type: "function",
  name: "get_file",
  description: "Read a file the caller declared itself.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

function responsesBody() {
  return {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "read /etc/hostname" }] }],
    tools: [{ ...CALLER_TOOL }],
    tool_choice: "auto",
  };
}

function functionCall(name) {
  return { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "{}" };
}

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function runPassthrough(toolNameMap, sseText) {
  const stream = createPassthroughStreamWithLogger("opencode", null, "m", "c1", null, null, null, toolNameMap);
  const writer = stream.writable.getWriter();
  const readPromise = drain(stream.readable);
  await writer.write(new TextEncoder().encode(sseText));
  await writer.close();
  return readPromise;
}

describe("opencode fingerprint — Responses terminal body restore", () => {
  it("restores the name nested under response.output in response.completed", () => {
    const map = new Map([["fn_1kyuucu", "get_file"]]);
    const chunk = {
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [functionCall("fn_1kyuucu")] },
    };

    const out = restoreToolNames(chunk, map);

    expect(out.response.output[0].name).toBe("get_file");
  });

  it("restores the name inside the {event, data} SSE envelope", () => {
    // formatSSE re-serialises `data` as the frame body, so an unstripped alias
    // here reaches the client even though the outer object looks clean.
    const map = new Map([["fn_1kyuucu", "get_file"]]);
    const chunk = {
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: 0, item: functionCall("fn_1kyuucu") },
    };

    const out = restoreToolNames(chunk, map);

    expect(out.data.item.name).toBe("get_file");
  });

  it("leaves a top-level output[] untouched when it belongs to another shape", () => {
    const map = new Map([["fn_1kyuucu", "get_file"]]);
    const chunk = { response: { output: [{ type: "message", role: "assistant" }] } };

    const out = restoreToolNames(chunk, map);

    expect(out.response.output[0].type).toBe("message");
  });

  it("hands the client its own tool name across the whole Responses stream", async () => {
    const body = responsesBody();
    const map = applyFingerprintTools(body, true);
    expect(map.size).toBeGreaterThan(0);

    const item = functionCall("fn_1kyuucu");
    const sse = [
      ["response.output_item.added", { type: "response.output_item.added", item, output_index: 0 }],
      ["response.output_item.done", { type: "response.output_item.done", item, output_index: 0 }],
      ["response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item] } }],
    ]
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");

    const out = await runPassthrough(map, sse);

    expect(out).not.toContain("fn_1kyuucu");
    expect(out.match(/"name":"get_file"/g)).toHaveLength(3);
  });
});

describe("opencode fingerprint — transformRequest idempotence", () => {
  it("does not re-alias an already fingerprinted body", () => {
    const body = responsesBody();
    const first = applyFingerprintTools(body, true);
    const aliasAfterFirst = body.tools.find((t) => t.name.startsWith("fn_")).name;

    const second = applyFingerprintTools(body, true);
    const aliasAfterSecond = body.tools.find((t) => t.name.startsWith("fn_")).name;

    expect(aliasAfterSecond).toBe(aliasAfterFirst);
    expect(second).toBe(first);
    expect(takeRenamedToolNames(body).get(aliasAfterFirst)).toBe("get_file");
  });

  it("does not append the env fingerprint system message twice", () => {
    const body = responsesBody();
    applyFingerprintTools(body, true);
    const systemCountFirst = body.input.filter((i) => i.role === "system").length;

    applyFingerprintTools(body, true);

    expect(body.input.filter((i) => i.role === "system")).toHaveLength(systemCountFirst);
  });
});
