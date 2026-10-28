import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spawnLog = path.join("/tmp", `opencode-transport-spawns-${process.pid}.log`);

vi.hoisted(() => {
  process.env.OPENCODE_TRANSPORT = "auto";
  process.env.OPENCODE_TRANSPORT_HEADER_TIMEOUT_MS = "300";
});

let transport;

beforeEach(async () => {
  rmSync(spawnLog, { force: true });
  process.env.SPAWN_LOG = spawnLog;
  process.env.OPENCODE_TRANSPORT_SCRIPT = path.join(__dirname, "../fixtures/timeout-sidecar.mjs");
  transport = await import("../../open-sse/utils/opencodeTransport.js");
  transport.resetTransport();
});

afterEach(() => {
  transport?.resetTransport();
  rmSync(spawnLog, { force: true });
});

function spawnCount() {
  if (!existsSync(spawnLog)) return 0;
  return readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).length;
}

describe("OpenCode transport upstream-timeout cooldown", () => {
  it("fails fast on a sidecar 504 timeout without retrying the same egress", async () => {
    const body = JSON.stringify({ stream: true, messages: [] });
    const first = await transport.fetchViaTransport("https://upstream.invalid/v1/chat/completions", { body, headers: {} }, null);
    expect(first).toBeNull();
    // 超时后 retire 一次、请求直接交回上层换出口；同一出口不再重试，
    // 所以只 spawn 过一次（旧实现会 attempt 1 复用同出口，把 20s 拖成 40s）。
    expect(spawnCount()).toBe(1);

    const second = await transport.fetchViaTransport("https://upstream.invalid/v1/chat/completions", { body, headers: {} }, null);
    expect(second).toBeNull();
    // 30s 冷却内允许开新 sidecar（清僵死 socket），但不允许再次 retire 造成 spawn 风暴。
    expect(spawnCount()).toBe(2);

    const third = await transport.fetchViaTransport("https://upstream.invalid/v1/chat/completions", { body, headers: {} }, null);
    expect(third).toBeNull();
    expect(spawnCount()).toBe(2);
  }, 15000);
});
