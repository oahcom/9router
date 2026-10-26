import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.hoisted(() => {
  process.env.OPENCODE_TRANSPORT = "auto";
  process.env.OPENCODE_TRANSPORT_HEADER_TIMEOUT_MS = "300";
});

let transport;

beforeEach(async () => {
  process.env.OPENCODE_TRANSPORT_SCRIPT = path.join(__dirname, "../fixtures/hanging-sidecar.mjs");
  transport = await import("../../open-sse/utils/opencodeTransport.js");
  transport.resetTransport();
});

afterEach(() => {
  transport?.resetTransport();
});

describe("OpenCode transport header timeout", () => {
  it("fails fast instead of waiting for the caller's 60s abort on a stalled egress", async () => {
    const started = Date.now();
    const response = await transport.fetchViaTransport(
      "https://upstream.invalid/v1/chat/completions",
      { body: JSON.stringify({ stream: true, messages: [] }), headers: {} },
      null
    );

    expect(response).toBeNull();
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("does not apply the header timeout to non-streaming requests", async () => {
    const started = Date.now();
    const response = await transport.fetchViaTransport(
      "https://upstream.invalid/v1/chat/completions",
      {
        body: JSON.stringify({ stream: false, messages: [] }),
        headers: {},
        signal: AbortSignal.timeout(800),
      },
      null
    );

    expect(response).toBeNull();
    // 非流式不套 300ms 判死：必须活到调用方 signal 中止（≈800ms）
    expect(Date.now() - started).toBeGreaterThan(700);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
