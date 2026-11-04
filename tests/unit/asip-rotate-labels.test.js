// asip 换线客户端自己的错误标签：真超时、坏响应、截断响应、连不上、客户端取消，
// 五种在调用方眼里含义完全不同（要不要 bump、要不要重试）。
// opencode-asip-rotate 只 mock 了 rotateEgress，标签互换/挂死都抓不到 ——
// 线上出现过「真超时记成 unavailable、垃圾响应记成 timeout」（2026-10-30 审查）。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// mkdtemp 而不是写死 /tmp/opencode：共享机器上那个目录可能不可写，
// 而且每跑一次都会留下一个 token 文件（审查发现 /tmp 里攒了 39 个）。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "asip-labels-"));
const SOCK = path.join(DIR, "rotate.sock");
const TOKEN_FILE = path.join(DIR, "api-token");

const { rotateEgress, forgetActiveLine } = await (async () => {
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
  fs.writeFileSync(TOKEN_FILE, "test-token", { mode: 0o600 });
  // 出口身份是模块级状态，不重置就会让上一条用例的结论决定下一条。
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

describe("asip rotate error labels", () => {
  it("reports timeout when the daemon accepts but never answers", async () => {
    await listen(() => {});
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("timeout");
    expect(result.switchedAt).toBe(0);
  });

  it("reports bad-status when the daemon answers 5xx", async () => {
    await listen((socket) => {
      socket.on("data", () => {
        const body = "<html>no</html>";
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: " +
            body.length + "\r\n\r\n" + body
        );
      });
    });
    const result = await rotateEgress("rate429");
    // 带状态码比笼统的 bad-response 好排障：一眼看出是网关那一层出的问题。
    expect(result.reason).toBe("bad-status-502");
  });

  it("reports bad-response when the daemon answers 200 with non-JSON", async () => {
    await listen((socket) => {
      socket.on("data", () => {
        const body = "<html>ok</html>";
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " +
            body.length + "\r\n\r\n" + body
        );
      });
    });
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("bad-response");
  });

  it("reports bad-response instead of hanging when the daemon is cut mid-response", async () => {
    // asip 换线途中被 systemd 重启：响应半截断掉，end 永远不来。
    // 旧实现只挂 data/end -> await 永久 pending（实测 3s 不 settle）。
    await listen((socket) => {
      socket.on("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"ok\":"
        );
        setTimeout(() => socket.destroy(), 20);
      });
    });
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("bad-response");
  });

  it("reports aborted when the daemon sent headers but the body never finished", async () => {
    // 最窄的那个窗口：头到了、body 没写完。这时 req.destroy() 不会再发 error，
    // 只有 close —— 光靠兜底会把标签记成 socket，更早的实现直接挂死（实测 12s）。
    await listen((socket) => {
      socket.on("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n");
      });
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await rotateEgress("rate429", { signal: controller.signal });
    expect(result.reason).toBe("aborted");
  });

  it("reports socket when the token file is corrupt enough to make http.request throw", async () => {
    // http.request 会同步抛（header 里有非法字符）：不接住就变成 reject，
    // 异常穿出 execute()，用户请求变 500 —— 而这里是「失败只降级」。
    fs.writeFileSync(TOKEN_FILE, "tok\u4e2dn", { mode: 0o600 });
    await listen(() => {});
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("socket");
  });

  it("reports socket when nothing is listening", async () => {
    const result = await rotateEgress("rate429");
    expect(result.reason).toBe("socket");
  });

  it("reports aborted when the caller aborts while the request is in flight", async () => {
    await listen(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await rotateEgress("rate429", { signal: controller.signal });
    expect(result.reason).toBe("aborted");
  });
});

describe("active line identity", () => {
  // asip 报回来的身份是「线名 + 出口地址」两项。只比线名会漏掉原地重连：
  // 那种换法 selector 不动、线名不变，但隧道被重启过、地址也换了。
  // 一个 server 按顺序回答，不在用例中间重开监听：listen() 会 unlink 再 bind，
  // 而上一个 server 的 close 是异步的，同一用例里重开就会撞 EADDRINUSE ——
  // 请求拿不到回话，lineChanged 恒 false，用例反而「通过」得莫名其妙。
  async function serveSequence(payloads) {
    let i = 0;
    return listen((socket) => {
      socket.on("data", () => {
        const body = JSON.stringify(payloads[Math.min(i++, payloads.length - 1)]);
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
            Buffer.byteLength(body) + "\r\n\r\n" + body
        );
      });
    });
  }

  it("first sighting never counts as a change", async () => {
    await serveSequence([{ ok: false, reason: "too_frequent", active_tag: "WG-7", active_egress: "1.1.1.1" }]);
    const result = await rotateEgress("rate429");
    expect(result.lineChanged).toBe(false);
  });

  it("detects a different egress address on the same line", async () => {
    // 原地重连：线名一样，地址变了 —— 连接全断过，必须算变了。
    await serveSequence([
      { ok: false, reason: "too_frequent", active_tag: "WG-7", active_egress: "1.1.1.1" },
      { ok: false, reason: "too_frequent", active_tag: "WG-7", active_egress: "2.2.2.2" },
    ]);
    await rotateEgress("rate429");
    const result = await rotateEgress("rate429");
    expect(result.lineChanged).toBe(true);
  });

  it("stays quiet when neither line nor address moved", async () => {
    await serveSequence([
      { ok: false, reason: "too_frequent", active_tag: "WG-7", active_egress: "1.1.1.1" },
      { ok: false, reason: "too_frequent", active_tag: "WG-7", active_egress: "1.1.1.1" },
    ]);
    await rotateEgress("rate429");
    const result = await rotateEgress("rate429");
    expect(result.lineChanged).toBe(false);
  });

  it("detects falling back to the proxy pool as a change", async () => {
    // 落池后 asip 两个字段都是 null。此时连接还挂在被换下那条隧道上，
    // 必须算变了，否则调用方什么都不做、继续骑在它上面。
    await serveSequence([
      { ok: false, reason: "too_frequent", active_tag: "WG-7", active_egress: "1.1.1.1" },
      { ok: false, reason: "too_frequent", active_tag: null, active_egress: null },
    ]);
    await rotateEgress("rate429");
    const result = await rotateEgress("rate429");
    expect(result.lineChanged).toBe(true);
  });
});
