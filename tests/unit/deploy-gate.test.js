import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// scripts/postdeploy_gate.sh 把 check_deploy_state.sh 的三态映射成调用方动作。
// 回归对象就是原缺陷：三处调用点用 `|| true` 把 1(MISMATCH) 和 2(UNAVAILABLE)
// 一起吞掉，「构建了没重启」于是永远静默。这里钉住映射本身。
//
// 必须用异步 execFile：spawnSync 会阻塞本进程事件循环，桩服务永远应不了答，
// 每个用例都退化成 UNAVAILABLE（实测 3 failed，stderr 全是 rc=2）。

const runAsync = promisify(execFile);

const ROOT = resolve(__dirname, "../..");
const GATE = join(ROOT, "scripts/postdeploy_gate.sh");

let distDir;
let server;
let healthUrl;

async function run(mode, env = {}) {
  const args = mode ? [GATE, mode] : [GATE];
  try {
    const { stdout, stderr } = await runAsync("bash", args, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NEXT_DIST_DIR: distDir, HEALTH_URL: healthUrl, ...env },
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    return { status: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
  writeFileSync(join(distDir, "BUILD_ID"), "BUILD-DISK\n");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, buildId: "BUILD-DISK" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  healthUrl = `http://127.0.0.1:${server.address().port}/api/health`;
});

afterAll(() => {
  server?.close();
  rmSync(distDir, { recursive: true, force: true });
});

describe("postdeploy_gate", () => {
  it("passes through MATCH as success in both modes", async () => {
    expect((await run()).status).toBe(0);
    expect((await run("strict")).status).toBe(0);
  });

  it("warns but succeeds on MISMATCH in postbuild mode", async () => {
    // 刚构建完必然 MISMATCH —— 让构建失败会把正常流程判成错误。
    writeFileSync(join(distDir, "BUILD_ID"), "BUILD-NEW\n");
    const r = await run();
    expect(r.stderr).toContain("MISMATCH");
    expect(r.status).toBe(0);
  });

  it("fails on MISMATCH in strict mode", async () => {
    // 重启后仍 MISMATCH = 这次重启没生效，必须以非 0 收场。
    writeFileSync(join(distDir, "BUILD_ID"), "BUILD-NEW\n");
    const r = await run("strict");
    expect(r.stderr).toContain("MISMATCH");
    expect(r.status).toBe(1);
  });

  it("only warns on UNAVAILABLE (cannot judge is not a verdict)", async () => {
    const r = await run("strict", { HEALTH_URL: "http://127.0.0.1:1/api/health" });
    expect(r.stderr).toContain("UNAVAILABLE");
    expect(r.status).toBe(0);
  });
});
