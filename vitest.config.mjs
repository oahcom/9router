import path from "node:path";

// 与 jsconfig.json 的 paths 对齐：`@/*` -> src/*，`open-sse` -> open-sse/。
// 之前没有这份配置，引用 src/lib/db/paths.js 的测试（egress / opencode-session /
// transport-failover）全部在 import 阶段就报 Cannot find package '@/lib/...'，
// 等于这些用例从未真正跑过。
export default {
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "open-sse": path.resolve(import.meta.dirname, "open-sse"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
  },
};
