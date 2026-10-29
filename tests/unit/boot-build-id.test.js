import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 端到端：instrumentation.register() 在进程启动时钉住 BUILD_ID，
// 之后磁盘换成新构建，health 仍须报启动时的那个值 —— 否则「构了没重启」被报成 MATCH。
// 这里走真实 buildInfo 读盘（不 mock），只把 NEXT_DIST_DIR 指到临时目录。

const BOOT_KEY = "__NINEROUTER_BOOT_BUILD_ID__";

let distDir;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), "boot-id-"));
  writeFileSync(join(distDir, "BUILD_ID"), "BUILD-OLD\n");
  process.env.NEXT_DIST_DIR = distDir;
  delete globalThis[BOOT_KEY];
  delete process.env.NEXT_RUNTIME;
});

afterEach(() => {
  delete globalThis[BOOT_KEY];
  delete process.env.NEXT_DIST_DIR;
  rmSync(distDir, { recursive: true, force: true });
});

describe("boot-time buildId capture", () => {
  it("health reports the boot build id after the disk moved on", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("../../src/instrumentation.js");
    await register();

    // 进程还在跑旧构建，磁盘已经换成新构建
    writeFileSync(join(distDir, "BUILD_ID"), "BUILD-NEW\n");

    const { GET } = await import("../../src/app/api/health/route.js");
    const body = await (await GET()).json();
    expect(body.buildId).toBe("BUILD-OLD");
  });
});
