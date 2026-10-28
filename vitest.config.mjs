import path from "node:path";

// 与 jsconfig.json 的 paths 对齐：`@/*` -> src/*，`open-sse` -> open-sse/。
// 之前没有这份配置，引用 src/lib/db/paths.js 的测试（egress / opencode-session /
// transport-failover）全部在 import 阶段就报 Cannot find package '@/lib/...'，
// 等于这些用例从未真正跑过。
//
// 2026-10-28：加了 setupFiles（测试不许碰真实出口，见 tests/setup.js）和 live 分流。
// live 用例打的是真上游，每次结果都可能不一样（mimo-free / zed-native-auth），
// 放进默认 `npm test` 等于永远红一条：默认排除，要跑用 `npm run test:live`。
export default ({ mode } = {}) => {
  const live = mode === "live";
  return {
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "open-sse": path.resolve(import.meta.dirname, "open-sse"),
      },
    },
    test: {
      environment: "node",
      include: ["tests/**/*.test.js"],
      exclude: live
        ? ["**/node_modules/**"]
        : [
            "**/node_modules/**",
            "**/*.live.test.js",
            // 这份测试 import 的是 `cloud/` 那套服务（兄弟仓库，不在本仓库里），
            // 在这里永远 import 失败。留着文件，等那份代码在的时候再放开。
            "tests/unit/embeddings.cloud.test.js",
          ],
      setupFiles: ["./tests/setup.js"],
    },
  };
};
