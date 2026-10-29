// 全量测试的入口环境：不许碰真实出口。
//
// 2026-10-28 实测：egress-pool-identity 的 429 用例会走到 opencode.js 的
// asip 换线分支，而 asip 的 /rotate 是同步切生产 sing-box 选择器 —— 一次
// `npx vitest run` 真的换掉了线上出口，日志里能看到 switched:true。
// 测试不该有这种副作用，也不该依赖本机 asip 是否在跑。
process.env.ASIP_DISABLED = "1";

// Bun sidecar 的用例要 spawn bun。本机装了（~/.bun/bin/bun，1.4.4），但默认 PATH
// 里没有 —— 之前 3 条 transport 用例因此假红并被写进 known-fails，属误诊。
// 这里只往 PATH 前面补一条存在的目录，不影响别的用例。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const bunDir = path.join(os.homedir(), ".bun", "bin");
if (fs.existsSync(path.join(bunDir, "bun"))) {
  const parts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (!parts.includes(bunDir)) process.env.PATH = [bunDir, ...parts].join(path.delimiter);
}
