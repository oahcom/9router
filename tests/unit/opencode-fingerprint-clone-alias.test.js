/**
 * 回归：克隆体上的二次别名（fn_xxx 套 fn_xxx）
 *
 * 故障形态（2026-11-11 实测复现）：
 *   请求体在 asip 轮换重试 / base 的 structuredClone 处被克隆 → 换了对象引用
 *   → opencodeFingerprint 的 WeakMap 幂等保护取不到上一轮的 map → 别名套别名：
 *       Bash → fn_18vix4v → fn_1ciz1x0
 *   上游回的是第二层 fn_1ciz1x0，单跳还原只回得到 fn_18vix4v —— 客户端
 *   从没声明过这个名字，于是 "No such tool available" / "fn_xxx does not exist"。
 *
 * 修法：别名登记表（aliasRegistry，跨 body 共享）当内容判据 —— 名字已在
 * 登记表里就说明这层改过名，复用而非再套一层。
 *
 * 本文件钉住：
 *   1. 克隆体不再产生第二层别名（核心）
 *   2. 多层克隆后名字恒定
 *   3. 还原能回到真名（三种真实响应形状）
 *   4. 同一 body 重复过闸的原有幂等保护仍成立
 *   5. 首轮真名不被误判成「已别名化」
 *   6. 指纹工具 read/shell 不被改名
 */
import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  takeRenamedToolNames,
  restoreToolNames,
} from "../../open-sse/utils/opencodeFingerprint.js";

const ALIAS_RE = /^fn_[0-9a-z]{7,}$/;

const makeBody = (names = ["Bash", "Read"]) => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  tools: names.map((name) => ({
    type: "function",
    function: { name, description: "d", parameters: {} },
  })),
});

const namesOf = (body) => body.tools.map((t) => t.function.name);

/** 上游回一个 OpenAI 形状的 tool_call，取还原后的名字。 */
const restoredName = (map, sentName) => {
  const resp = restoreToolNames(
    { choices: [{ delta: { tool_calls: [{ function: { name: sentName } }] } }] },
    map,
  );
  return resp.choices[0].delta.tool_calls[0].function.name;
};

describe("opencodeFingerprint 克隆体二次别名回归", () => {
  it("克隆体不再套第二层别名（核心故障）", () => {
    const body = makeBody();
    applyFingerprintTools(body, false);
    const first = namesOf(body);
    expect(first.filter((n) => ALIAS_RE.test(n)).length).toBe(2);

    // base.js 的 structuredClone / executor 的 asip 轮换重试都走这一步
    const cloned = structuredClone(body);
    applyFingerprintTools(cloned, false);
    expect(namesOf(cloned)).toEqual(first);
    // 绝不出现 fn_xxx → fn_yyy 的第二层
    const second = namesOf(cloned).filter((n) => ALIAS_RE.test(n));
    expect(second).toHaveLength(2);
    expect(new Set(second).size).toBe(2);
  });

  it("多层克隆后名字恒定，且每层 map 都指向真名", () => {
    let body = makeBody(["Bash"]);
    applyFingerprintTools(body, false);
    const sent = namesOf(body)[0];

    for (let i = 0; i < 3; i++) {
      body = structuredClone(body);
      const map = applyFingerprintTools(body, false);
      expect(namesOf(body)[0]).toBe(sent);
      expect(restoredName(map, sent)).toBe("Bash");
    }
  });

  it("克隆体上拿到的 map 能把上游回名还原成真名（三种响应形状）", () => {
    const body = makeBody(["Bash"]);
    applyFingerprintTools(body, false);
    const sent = namesOf(body)[0];
    const cloned = structuredClone(body);
    const map = applyFingerprintTools(cloned, false);

    // OpenAI Chat Completions
    expect(restoredName(map, sent)).toBe("Bash");

    // Claude content block
    const claude = restoreToolNames({ content: [{ type: "tool_use", name: sent }] }, map);
    expect(claude.content[0].name).toBe("Bash");

    // OpenAI Responses
    const responses = restoreToolNames({ output: [{ type: "function_call", name: sent }] }, map);
    expect(responses.output[0].name).toBe("Bash");
  });

  it("同一 body 重复过闸：原有幂等保护仍成立", () => {
    const body = makeBody(["Bash"]);
    const m1 = applyFingerprintTools(body, false);
    const n1 = namesOf(body)[0];
    const m2 = applyFingerprintTools(body, false);
    expect(namesOf(body)[0]).toBe(n1);
    expect([...m1]).toEqual([...m2]);
  });

  it("首轮真名不被误判成已别名化（map 的值必须是真名）", () => {
    const body = makeBody(["Bash", "Read"]);
    const map = applyFingerprintTools(body, false);
    expect(map.size).toBe(2);
    for (const v of map.values()) {
      expect(v).not.toMatch(ALIAS_RE);
      expect(["Bash", "Read"]).toContain(v);
    }
  });

  it("指纹工具 read/shell 不被改名，克隆后也不被改名", () => {
    const body = makeBody(["Bash"]);
    applyFingerprintTools(body, false);
    expect(namesOf(body)).toContain("read");
    expect(namesOf(body)).toContain("shell");

    const cloned = structuredClone(body);
    applyFingerprintTools(cloned, false);
    expect(namesOf(cloned)).toContain("read");
    expect(namesOf(cloned)).toContain("shell");
    expect(namesOf(cloned).some((n) => /_client\d/.test(n))).toBe(false);
  });

  it("克隆体的 map 记在克隆体上，takeRenamedToolNames 能在同一引用取到", () => {
    const body = makeBody(["Bash"]);
    applyFingerprintTools(body, false);
    const cloned = structuredClone(body);
    const map = applyFingerprintTools(cloned, false);
    expect(takeRenamedToolNames(cloned)).toBe(map);
    expect(takeRenamedToolNames(body)).not.toBe(map);
  });
});
