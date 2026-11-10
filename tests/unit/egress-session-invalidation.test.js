// 真 Bun sidecar 集成：L0「对端关闭连接」失败后，本端口的 session key 必须
// 变化，重试的那一发才能落在全新连接池上；稳态下 generation 不许抖动。
const HAS_BUN = globalThis.__HAS_BUN__ !== false;

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadLog = path.join("/tmp", `sidecar-payload-${process.pid}.log`);

vi.hoisted(() => {
  process.env.OPENCODE_TRANSPORT = "auto";
  process.env.OPENCODE_TRANSPORT_HEADER_TIMEOUT_MS = "300";
});

let transport;
const gen = await import("../../open-sse/utils/egressGeneration.js");

beforeEach(async () => {
  rmSync(payloadLog, { force: true });
  delete process.env.SIDECAR_FAIL_FIRST;
  process.env.SIDECAR_PAYLOAD_LOG = payloadLog;
  process.env.OPENCODE_TRANSPORT_SCRIPT =
    path.join(__dirname, "../fixtures/recording-sidecar.mjs");
  transport = await import("../../open-sse/utils/opencodeTransport.js");
  gen.resetEgressGenerationForTest();
  transport.resetTransport();
});

afterEach(() => {
  transport?.resetTransport();
  delete process.env.SIDECAR_FAIL_FIRST;
  rmSync(payloadLog, { force: true });
});

function rows() {
  if (!existsSync(payloadLog)) return [];
  return readFileSync(payloadLog, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
}

const PROXY = { enabled: true, url: "http://127.0.0.1:7890" };
const TARGET = "https://upstream.invalid/v1/chat/completions";
const BODY = JSON.stringify({ stream: true, messages: [] });
const call = () => transport.fetchViaTransport(
  TARGET, { body: BODY, headers: {} }, PROXY);

describe.skipIf(!HAS_BUN)("L0 socket failure invalidates only its own port", () => {
  it("recovers on a fresh connection and rotates the per-port generation", async () => {
    process.env.SIDECAR_FAIL_FIRST = "1";
    const otherBefore = gen.generationFor("http://127.0.0.1:7893");

    const response = await call();
    expect(response?.status, "第二发（全新连接）应当救回请求").toBe(200);

    const r = rows();
    expect(r.length, "首发失败 + 一次全新连接重试").toBe(2);
    expect(r[0].proxy).toBe("http://127.0.0.1:7890");
    expect(r[1].generation, "重试必须用新的 session key").not.toBe(r[0].generation);
    expect(gen.generationFor("http://127.0.0.1:7893"),
      "别的端口不应被连累").toBe(otherBefore);
  });

  it("keeps the generation stable when nothing fails", async () => {
    expect((await call())?.status).toBe(200);
    expect((await call())?.status).toBe(200);
    const r = rows();
    expect(r.length).toBe(2);
    expect(r[1].generation).toBe(r[0].generation);
    expect(gen.egressGenerationSnapshotForTest().perPort["7890"]).toBeUndefined();
  });
});
