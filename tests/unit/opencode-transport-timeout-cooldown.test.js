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
  it("treats a sidecar 504 timeout like a header timeout: one retry, then 30s cooldown", async () => {
    const body = JSON.stringify({ stream: true, messages: [] });
    const first = await transport.fetchViaTransport("https://upstream.invalid/v1/chat/completions", { body, headers: {} }, null);
    expect(first).toBeNull();
    const afterFirst = spawnCount();
    expect(afterFirst).toBe(2);

    const second = await transport.fetchViaTransport("https://upstream.invalid/v1/chat/completions", { body, headers: {} }, null);
    expect(second).toBeNull();
    expect(spawnCount()).toBe(afterFirst);
  }, 15000);
});
