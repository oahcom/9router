export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 构建标识必须在进程启动时钉住：路由模块的顶层代码在首个请求才求值
    // （实测 next start / standalone 下空闲 16s 仍是 0 次求值），
    // 那时读盘读到的是新构建 → 「构了没重启」被 health 报成 MATCH。
    // 用 globalThis 传递，因为 route 与 instrumentation 同进程、同一个 global。
    const { readBuildId } = await import("@/lib/buildInfo");
    globalThis.__NINEROUTER_BOOT_BUILD_ID__ = readBuildId(process.env.NEXT_DIST_DIR || ".next");

    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
