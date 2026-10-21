#!/usr/bin/env node
/**
 * 并行 tool_call 分桶自检（零依赖，node 直跑）。
 * 症状：上游省略/重复 index 时两个调用的 arguments 被拼进同一块 →
 * 客户端 {__unparsedToolInput:{raw:'{"a":1}{"b":2}'}} → InputValidationError。
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_alias-loader.mjs", import.meta.url);
const { openaiToClaudeResponse } = await import("../../open-sse/translator/response/openai-to-claude.js");

const createState = () => ({ toolCalls: new Map(), nextBlockIndex: 0 });
const starts = (ev) => ev.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
const deltas = (ev) => ev.filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta");

// 1) 上游完全省略 index，两个不同 id 的调用
{
  const s = createState();
  const all = openaiToClaudeResponse({ id: "c1", model: "m", choices: [{ delta: { tool_calls: [
    { id: "toolu_a", function: { name: "Bash", arguments: '{"command":"echo a"}' } },
    { id: "toolu_b", function: { name: "Bash", arguments: '{"command":"echo b"}' } },
  ] } }] }, s);
  const ev = [...(all ?? []), ...openaiToClaudeResponse({ id: "c1", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] }, s)];
  assert.deepEqual(starts(ev).map((e) => e.content_block.id), ["toolu_a", "toolu_b"], "省略 index 时两个调用必须各开一块");
  assert.deepEqual(deltas(ev).map((e) => JSON.parse(e.delta.partial_json)),
    [{ command: "echo a" }, { command: "echo b" }], "两个调用的 arguments 不得拼接");
}

// 2) 上游重复 index=0，两个不同 id 的调用
{
  const s = createState();
  const all2 = openaiToClaudeResponse({ id: "c2", model: "m", choices: [{ delta: { tool_calls: [
    { index: 0, id: "toolu_c", function: { name: "Read", arguments: '{"file_path":"/a"}' } },
    { index: 0, id: "toolu_d", function: { name: "Read", arguments: '{"file_path":"/b"}' } },
  ] } }] }, s);
  const ev = [...(all2 ?? []), ...openaiToClaudeResponse({ id: "c2", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] }, s)];
  assert.deepEqual(starts(ev).map((e) => e.content_block.id), ["toolu_c", "toolu_d"], "重复 index 时必须按 id 分桶");
  assert.deepEqual(deltas(ev).map((e) => JSON.parse(e.delta.partial_json)),
    [{ file_path: "/a" }, { file_path: "/b" }]);
}

// 3) 同一调用的分片流（每片重复 id）：必须仍是一块、参数完整
{
  const s = createState();
  const a3 = openaiToClaudeResponse({ id: "c3", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_e", function: { name: "Bash", arguments: '{"comm' } }] } }] }, s);
  const b3 = openaiToClaudeResponse({ id: "c3", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_e", function: { arguments: 'and":"ls"}' } }] } }] }, s);
  const ev = [...(a3 ?? []), ...(b3 ?? []), ...openaiToClaudeResponse({ id: "c3", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] }, s)];
  assert.equal(starts(ev).length, 1, "同一调用分片不得开新块");
  assert.deepEqual(JSON.parse(deltas(ev)[0].delta.partial_json), { command: "ls" });
}

// 4) 上游把同一调用的完整参数重复下发：不得拼成两个对象
{
  const s = createState();
  const args = '{"command":"ls"}';
  const a4 = openaiToClaudeResponse({ id: "c4", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_f", function: { name: "Bash", arguments: args } }] } }] }, s);
  const b4 = openaiToClaudeResponse({ id: "c4", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_f", function: { arguments: args } }] } }] }, s);
  const ev = [...(a4 ?? []), ...(b4 ?? []), ...openaiToClaudeResponse({ id: "c4", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] }, s)];
  assert.equal(starts(ev).length, 1, "重复下发不得多开块");
  assert.deepEqual(JSON.parse(deltas(ev)[0].delta.partial_json), { command: "ls" }, "重复下发不得拼成两个对象");
}

// 5) 同一份参数在**一个分片里**发两遍：只能输出一个对象
{
  const s = createState();
  const one = '{"command":"ls"}';
  const a5 = openaiToClaudeResponse({ id: "c5", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_g", function: { name: "Bash", arguments: one + one } }] } }] }, s);
  const ev = [...(a5 ?? []), ...openaiToClaudeResponse({ id: "c5", model: "m", choices: [{ delta: {}, finish_reason: "tool_calls" }] }, s)];
  assert.equal(starts(ev).length, 1);
  assert.deepEqual(JSON.parse(deltas(ev)[0].delta.partial_json), { command: "ls" });
}

console.log("ok — parallel tool calls bucketed per id");
