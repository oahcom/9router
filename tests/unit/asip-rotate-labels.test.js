// asip 换线客户端自己的错误标签：真超时、坏响应、连不上、客户端取消，
// 四种在调用方眼里含义完全不同（要不要 bump、要不要重试）。
// 之前 opencode-asip-rotate 只 mock 了 rotateEgress，所以标签互换没人发现 ——
// 线上出现过「真超时记成 unavailable、垃圾响应记成 timeout」（2026-10-30 审查）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const SOCK = path.join("/tmp/opencode", "asip-labels-" + process.pid + ".sock");
const TOKEN_FILE = path.join("/tmp/opencode", "asip-labels-" + process.pid + ".token");

const { rotateEgress } = await (async () => {
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
    // 静默/挂住的连接会让 server.close() 永远等下去：自己记着，收尾时直接掐。
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(SOCK, () => resolve());
  });
}

beforeEach(() => {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  fs.writeFileSync(TOKEN_FILE, "test-token", { mode: 0o600 });
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

describe("asip rotate error labels", () => {
  it("reports timeout when the daemon accepts but never answers", async () => {
    await listen(() => {});
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("timeout");
    expect(result.switchedAt).toBe(0);
  });

  it("reports bad-response when the daemon answers non-JSON", async () => {
    await listen((socket) => {
      socket.on("data", () => {
        const body = "<html>no</html>";
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: " + body.length + "\r\n\r\n" + body);
      });
    });
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("bad-response");
  });

  it("reports socket when nothing is listening", async () => {
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("socket");
  });

  it("reports aborted without touching the daemon when the caller is gone", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await rotateEgress("rate429", { signal: controller.signal });
    expect(result.reason).toBe("aborted");
  });
});
