import { describe, it, expect } from "vitest";
import {
  applyEnvFingerprint,
  envWorkdirFor,
  envFingerprintPrompt,
} from "../../open-sse/utils/opencodeFingerprint.js";

// 2026-11-14：env workdir 从逐请求随机改为逐会话确定。
// 动机：随机 env 每发改写系统提示词尾部 → 上游前缀缓存断在 8960 token，
// 100K+ 会话历史每条请求全量重算 prefill（命中率 5-8%）。

function bodyWith(firstUserText) {
  return {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: firstUserText },
    ],
    tools: [],
  };
}

function workdirOf(body) {
  const line = String(body.messages[0].content)
    .split("\n")
    .find((l) => l.includes("Working directory:"));
  return line ? line.trim() : null;
}

describe("env fingerprint 会话稳定", () => {
  it("同一会话锚点两次注入产生逐字节相同的 workdir", () => {
    const b1 = bodyWith("帮我查一下账本的第一行");
    const b2 = bodyWith("帮我查一下账本的第一行");
    expect(applyEnvFingerprint(b1, false)).toBe(true);
    expect(applyEnvFingerprint(b2, false)).toBe(true);
    expect(workdirOf(b1)).toMatch(/^Working directory: \S+/);
    expect(workdirOf(b1)).toBe(workdirOf(b2));
  });

  it("同会话 100 次推导恒定", () => {
    const w = envWorkdirFor("fixed-key");
    expect(w).toBeTruthy();
    for (let i = 0; i < 100; i += 1) {
      expect(envWorkdirFor("fixed-key")).toBe(w);
    }
  });

  it("不同会话锚点得到不同路径（跨会话多样）", () => {
    const seen = new Set();
    for (const k of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
      seen.add(envWorkdirFor(k));
    }
    expect(seen.size).toBe(6);
  });

  it("无锚点回退随机路径，但仍带 <env> 标记", () => {
    const p = envFingerprintPrompt();
    expect(p).toContain("<env>");
    expect(p).toContain("Working directory:");
  });

  it("锚点为空串走随机回退", () => {
    const b1 = bodyWith("");
    b1.messages[1].content = [{ type: "text", text: "" }];
    applyEnvFingerprint(b1, false);
    expect(workdirOf(b1)).toBeTruthy();
  });

  it("自带 <env> 的真实客户端透传不改写", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: "sys\n\n<env>\n  Working directory: /home/user/project-real\n</env>",
        },
        { role: "user", content: "hi" },
      ],
      tools: [],
    };
    expect(applyEnvFingerprint(body, false)).toBe(false);
    expect(workdirOf(body)).toBe("Working directory: /home/user/project-real");
  });

  it("不同消息形状（flat instructions）也稳定", () => {
    const mk = () => ({ instructions: "inst", input: [{ role: "user", content: "same-question" }] });
    const f1 = mk();
    const f2 = mk();
    applyEnvFingerprint(f1, true);
    applyEnvFingerprint(f2, true);
    const wd = (b) => b.instructions.split("\n").find((l) => l.includes("Working directory:"));
    expect(wd(f1)).toBeTruthy();
    expect(wd(f1)).toBe(wd(f2));
  });
});
