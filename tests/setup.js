// 全量测试的入口环境：不许碰真实出口。
//
// 2026-10-28 实测：egress-pool-identity 的 429 用例会走到 opencode.js 的
// asip 换线分支，而 asip 的 /rotate 是同步切生产 sing-box 选择器 —— 一次
// `npx vitest run` 真的换掉了线上出口，日志里能看到 switched:true。
// 测试不该有这种副作用，也不该依赖本机 asip 是否在跑。
process.env.ASIP_DISABLED = "1";
