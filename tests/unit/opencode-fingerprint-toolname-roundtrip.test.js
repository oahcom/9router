import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  takeRenamedToolNames,
  restoreToolNames,
} from "../../open-sse/utils/opencodeFingerprint.js";

// 回归背景（2026-11-11 fn_18vix4v 故障，hermes 会话全工具 "No such tool
// available"）：请求侧 neutralizeCallerToolNames 把真名改成 fn_<hash> 存进
// WeakMap（按 body 对象引用记账）；响应侧 restoreToolNames 拿不到 map 时
// **静默原样透传**（不报错不告警）。此前 chatCore 只用 translatedBody 引用
// 取 map，而 base.js 的 transformRequest 在 replayBody（克隆体）上执行 ——
// 引用不匹配 → map 取不到 → fn_xxx 原样回流 → 客户端报未知工具。
// 修复 fb8cf5e6：base.js:397 在 transformRequest 的同一引用上取 map 并以
// result.renamedToolMap 显式带出；chatCore.js:421 优先取 result.renamedToolMap。
// 本文件把「请求别名 ↔ 还原真名」的一致性钉死，防止同类改动再次静默断链。

function chatTool(name, desc = `caller tool ${name}`) {
  return { type: "function", function: { name, description: desc, parameters: { type: "object" } } };
}

function flatTool(name, desc = `caller tool ${name}`) {
  return { type: "function", name, description: desc, parameters: { type: "object" } };
}

function buildBody({ flat = false, withHistory = false } = {}) {
  const body = {
    model: "gpt-x",
    stream: true,
    tools: flat
      ? [flatTool("read", "custom read wording"), flatTool("skill"), flatTool("task"), flatTool("webfetch")]
      : [chatTool("read", "custom read wording"), chatTool("skill"), chatTool("task"), chatTool("webfetch")],
  };
  if (withHistory) {
    body.messages = [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "skill", arguments: "{}" } }] },
    ];
  }
  return body;
}

const isAlias = (n) => /^fn_[0-9a-z]{7}$/.test(n) || /_client/.test(n);

describe("opencodeFingerprint 工具名一致性", () => {
  it("请求侧：所有 caller 真名都被换成稳定中性别名，且别名→真名记账完整", () => {
    const body = buildBody({ flat: true, withHistory: true });
    const originals = ["read", "skill", "task", "webfetch"];
    const map = applyFingerprintTools(body, true);

    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBeGreaterThan(0);
    for (const tool of body.tools) {
      const n = tool.name;
      expect(isAlias(n) || n === "read" || n === "shell").toBe(true);
      if (isAlias(n)) expect(map.get(n)).toBeTruthy();
    }
    // 历史里的 tool_calls 也必须同步别名（否则多轮对话把真名又带回去）
    const histName = body.messages[1].tool_calls[0].function.name;
    expect(isAlias(histName)).toBe(true);
    expect(map.get(histName)).toBe("skill");
    // 别名稳定性：同一名字永远同一别名（FNV，7 位 base36）
    const body2 = buildBody({ flat: true });
    const map2 = applyFingerprintTools(body2, true);
    const aliasOf = (m, orig) => [...m.entries()].find(([, v]) => v === orig)?.[0];
    expect(aliasOf(map2, "skill")).toBe(aliasOf(map, "skill"));
  });

  it("同一 body 重复过闸不得二次别名（read → fn_x → fn_y 历史 bug）", () => {
    const body = buildBody({ flat: true });
    const map1 = applyFingerprintTools(body, true);
    const names1 = body.tools.map((t) => t.name);
    const map2 = applyFingerprintTools(body, true);
    expect(map2).toBe(map1);
    expect(body.tools.map((t) => t.name)).toEqual(names1);
  });

  it("还原侧：全部响应形态还原回真名，深度扫描零别名残留", () => {
    const body = buildBody({ flat: true });
    const map = applyFingerprintTools(body, true);
    const aliasOf = (m, orig) => [...m.entries()].find(([, v]) => v === orig)?.[0];
    const aSkill = aliasOf(map, "skill");
    const aTask = aliasOf(map, "task");
    const aRead = aliasOf(map, "read");
    expect(aSkill && aTask).toBeTruthy();

    const payloads = [
      // OpenAI chat 流式 delta
      { choices: [{ delta: { tool_calls: [{ id: "1", function: { name: aSkill, arguments: "{}" } }] } }] },
      // OpenAI chat 非 流式 message
      { choices: [{ message: { tool_calls: [{ id: "2", function: { name: aTask, arguments: "{}" } }] } }] },
      // Claude 流式 content_block_start
      { type: "content_block_start", content_block: { type: "tool_use", name: aSkill } },
      // Claude 非 流式 content[]
      { content: [{ type: "tool_use", name: aTask }] },
      // Responses output[]
      { output: [{ type: "function_call", name: aSkill }] },
      // Responses SSE item
      { item: { type: "function_call", name: aTask } },
      // SSE 信封 {event,data}：只还原外层会全丢
      { event: "chat", data: { choices: [{ delta: { tool_calls: [{ function: { name: aSkill } }] } }] } },
      // response.completed 终态：output 藏在 response 里
      { response: { output: [{ type: "function_call", name: aRead ?? aTask }] } },
    ];
    for (const p of payloads) {
      const restored = restoreToolNames(p, map);
      const s = JSON.stringify(restored);
      expect(s).not.toMatch(/fn_[0-9a-z]{7}/);
      expect(s).not.toMatch(/_client/);
    }
    // 终态里的名字确实还原成真名
    const done = restoreToolNames(payloads[7], map);
    const name = done.response.output[0].name;
    expect(["read", "shell", "skill", "task", "webfetch"]).toContain(name);
  });

  it("THE BUG 回归：map 按引用记账，克隆体取不到 —— map 必须在 transformRequest 的同一引用上取", () => {
    const original = buildBody({ flat: true });
    const replayBody = JSON.parse(JSON.stringify(original)); // cloneRequestBody 等价
    // base.js:333 契约：transformRequest 在 replayBody || body 上执行，
    // applyFingerprintTools 的记账落在**那个引用**上
    const expected = applyFingerprintTools(replayBody, true);
    // base.js:397 契约：在**同一引用**上取 → 必须拿到完整 map
    const renamedToolMap = takeRenamedToolNames(replayBody);
    expect(renamedToolMap).toBe(expected);
    expect(renamedToolMap.size).toBeGreaterThan(0);
    // 旧 chatCore 写法（用别的引用取）→ null：这就是 fn_xxx 静默透传的根源
    expect(takeRenamedToolNames(original)).toBeNull();
    expect(takeRenamedToolNames(JSON.parse(JSON.stringify(replayBody)))).toBeNull();
  });

  it("chatCore 优先级契约：result.renamedToolMap 缺失时才回退引用查找（镜像 chatCore.js:421，改那行须同步本用例）", () => {
    const replayBody = buildBody({ flat: true });
    applyFingerprintTools(replayBody, true);
    const renamedToolMap = takeRenamedToolNames(replayBody);
    // 故障场景：translatedBody / finalBody 是别的引用（WeakMap 取不到），
    // 只有 result.renamedToolMap 带出了 map
    const translatedBody = { tools: [] };
    const finalBody = JSON.parse(JSON.stringify(replayBody));
    const picked = renamedToolMap
      || takeRenamedToolNames(translatedBody)
      || takeRenamedToolNames(finalBody);
    expect(picked).toBe(renamedToolMap);
    expect(picked.size).toBeGreaterThan(0);
  });

  it("静默透传面被钉住：map 缺失时 restoreToolNames 原样返回（不报错）——所以上游必须保证 map 一定带出", () => {
    const payload = { choices: [{ delta: { tool_calls: [{ function: { name: "fn_18vix4v" } }] } }] };
    expect(restoreToolNames(payload, null)).toBe(payload);
    expect(restoreToolNames(payload, new Map())).toBe(payload);
    const s = JSON.stringify(restoreToolNames(payload, new Map()));
    expect(s).toContain("fn_18vix4v");
  });
});
