// 需要 Bun sidecar 的用例：没有 bun 的机器上 skip，别变成「基线之外的新失败」。
const HAS_BUN = globalThis.__HAS_BUN__ !== false;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import path from "node:path";

process.env.OPENCODE_TRANSPORT = "auto";
process.env.OPENCODE_BUN_BIN = process.env.OPENCODE_BUN_BIN || "bun";
process.env.OPENCODE_TRANSPORT_SCRIPT =
  path.resolve(import.meta.dirname, "../../scripts/opencode-transport.mjs");

const { fetchViaTransport, resetTransport } = await import("../../open-sse/utils/opencodeTransport.js");

function startTruncatedUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": "128",
      });
      res.write("data: partial\n\n");
      const timer = setTimeout(() => res.destroy(), 50);
      res.on("close", () => clearTimeout(timer));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      close: () => server.close(),
    }));
  });
}

describe.skipIf(!HAS_BUN)("sidecar mid-stream logging", () => {
  let upstream;

  beforeEach(async () => {
    resetTransport();
    upstream = await startTruncatedUpstream();
  });

  afterEach(() => {
    upstream?.close();
    resetTransport();
    vi.restoreAllMocks();
  });

  it("logs the request id and delivered byte count when the upstream body breaks", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetchViaTransport(
      `http://127.0.0.1:${upstream.port}/truncated`,
      { method: "POST", headers: {}, body: '{"stream":true}' },
      { enabled: true, url: null },
      { opencodeRequestId: "req-stream-cut" },
    );

    expect(response, "响应头之后断流，fetch 本身应已成功").not.toBeNull();
    expect(response.status).toBe(200);
    await response.text().catch(() => "");

    await vi.waitFor(() => {
      const output = errorLog.mock.calls.flat().join(" ");
      expect(output).toContain("upstream body");
      expect(output).toContain("req=req-stream-cut");
      expect(output).toContain("/truncated");
      expect(output).toMatch(/bytes=\d+/);
    }, { timeout: 3000 });
  }, 10000);
});
