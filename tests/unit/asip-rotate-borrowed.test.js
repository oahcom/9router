// asip /rotate payload 的 borrowed 断言：调用方显式标借道时，报障 body 必须带
// borrowed:true、日志带 borrowed=1；未借道（false / 未传）时 body 里不得出现
// borrowed 键。F2 审查：opencode transport 重放 429 打到 switchToUrl 端口时
// 属借道 —— body/session 全属于原线，不标的话 asip 会把被借端口判死 24h。
// 只 mock rotateEgress 的执行器测试（opencode-asip-rotate）抓不到 payload，
// 这里用真 socket 服务端收包核对（同 asip-rotate-labels 的做法）。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "asip-borrowed-"));
const SOCK = path.join(DIR, "rotate.sock");
const TOKEN_FILE = path.join(DIR, "api-token");

const { rotateEgress, forgetActiveLine, clearAsipProxyCooling } = await (async () => {
  process.env.ASIP_SOCKET = SOCK;
  process.env.ASIP_TOKEN_FILE = TOKEN_FILE;
  process.env.ASIP_TIMEOUT_MS = "300";
  delete process.env.ASIP_DISABLED;
  return import("../../open-sse/utils/asipRotate.js");
})();

let server = null;
const sockets = new Set();

function listen(handler) {
  return new Promise((resolve) => {
    try { fs.unlinkSync(SOCK); } catch {}
    server = net.createServer(handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(SOCK, () => resolve());
  });
}

// 正常回 200 换线结论，同时捕获 POST /rotate 的 JSON body。
function serveCapture(payload) {
  const captured = { body: null };
  const promise = listen((socket) => {
    socket.on("data", (chunk) => {
      captured.raw = (captured.raw || "") + chunk.toString();
      const idx = captured.raw.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const headers = captured.raw.slice(0, idx);
      const lenMatch = headers.match(/Content-Length: (\d+)/i);
      const bodyStart = idx + 4;
      const len = lenMatch ? Number(lenMatch[1]) : 0;
      if (captured.raw.length - bodyStart < len) return;
      try { captured.body = JSON.parse(captured.raw.slice(bodyStart, bodyStart + len)); } catch {}
      const body = JSON.stringify(payload);
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
          Buffer.byteLength(body) + "\r\n\r\n" + body
      );
    });
  });
  return { promise, captured };
}

beforeEach(() => {
  fs.writeFileSync(TOKEN_FILE, "test-token", { mode: 0o600 });
  forgetActiveLine();
});

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    server.close();
    server = null;
  }
  try { fs.unlinkSync(SOCK); } catch {}
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const REPLY = { switched: true, switchedAt: Date.now(), reason: "ok" };
const SLOT_A = "http://127.0.0.1:7892";

describe("asip rotate borrowed payload", () => {
  it("sends borrowed:true and logs borrowed=1 when the caller flags a borrowed port", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { promise, captured } = serveCapture(REPLY);
      await promise;
      const result = await rotateEgress("rate429", {
        borrowed: true,
        reqId: "reqb1",
        proxyUrl: SLOT_A,
      });
      expect(result.reason).toBe("ok");
      expect(captured.body).toBeTruthy();
      expect(captured.body.borrowed).toBe(true);
      const logLine = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logLine).toContain(" borrowed=1");
      expect(logLine).toContain("req=reqb1");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    ["borrowed:false is passed", { reqId: "reqb0", borrowed: false }],
    ["borrowed is omitted", { reqId: "reqbn" }],
  ])("omits the borrowed key from the POST body when %s", async (_name, opts) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { promise, captured } = serveCapture(REPLY);
      await promise;
      await rotateEgress("rate429", { ...opts, proxyUrl: SLOT_A });
      expect(captured.body).toBeTruthy();
      expect(captured.body).not.toHaveProperty("borrowed");
      const logLine = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logLine).not.toContain("borrowed=");
    } finally {
      warnSpy.mockRestore();
    }
  });

  beforeEach(() => {
    clearAsipProxyCooling(SLOT_A);
  });
});
