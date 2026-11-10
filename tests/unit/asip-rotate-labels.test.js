// asip 换线客户端自己的错误标签：真超时、坏响应、截断响应、连不上、客户端取消，
// 五种在调用方眼里含义完全不同（要不要 bump、要不要重试）。
// opencode-asip-rotate 只 mock 了 rotateEgress，标签互换/挂死都抓不到 ——
// 线上出现过「真超时记成 unavailable、垃圾响应记成 timeout」（2026-10-30 审查）。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// mkdtemp 而不是写死 /tmp/opencode：共享机器上那个目录可能不可写，
// 而且每跑一次都会留下一个 token 文件（审查发现 /tmp 里攒了 39 个）。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "asip-labels-"));
const SOCK = path.join(DIR, "rotate.sock");
const TOKEN_FILE = path.join(DIR, "api-token");

const {
  rotateEgress,
  forgetActiveLine,
  isAsipProxyCooling,
  markAsipProxyCooling,
  clearAsipProxyCooling,
  requestAsipSelfRestart,
  resetAsipSelfRestartForTest,
  resetAsipSelfRestartMemoryForTest,
} = await (async () => {
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

// 多端口：回包里的 switch_to_url / avoid_port_until 是 asip 给调用方的两个抓手。
// 客户端这条链上（解析 -> 返回值 -> 冷却）任一处丢了字段，上层就只能盲重试。
describe("multi-slot redirect fields", () => {
  const SLOT_A = "http://127.0.0.1:7892";
  const SLOT_B = "http://127.0.0.1:7893";

  async function serveOnce(payload) {
    return listen((socket) => {
      socket.on("data", () => {
        const body = JSON.stringify(payload);
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
            Buffer.byteLength(body) + "\r\n\r\n" + body
        );
      });
    });
  }

  beforeEach(() => {
    clearAsipProxyCooling(SLOT_A);
    clearAsipProxyCooling(SLOT_B);
  });

  it("surfaces the healthy port asip points at", async () => {
    await serveOnce({
      ok: true,
      switched: false,
      reason: "coalesced",
      switch_to: "slot-3",
      switch_to_url: SLOT_B,
      switch_to_egress: "2606:slot3::1",
      avoid_port_until: 0,
    });

    const result = await rotateEgress("rate429", { proxyUrl: SLOT_A });

    expect(result.switchToUrl).toBe(SLOT_B);
    expect(result.switchToPool).toBe("slot-3");
    expect(result.switchToEgress).toBe("2606:slot3::1");
    // switched 仍然为 false：这一次调用什么都没换，只是指明了去处。
    expect(result.switched).toBe(false);
  });

  it("forwards retry_after_ms so asip can write a long ban_until", async () => {
    let seen = null;
    await listen((socket) => {
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        const marker = "\r\n\r\n";
        const at = text.indexOf(marker);
        const body = JSON.stringify({ ok: true, switched: false, reason: "coalesced", avoid_port_until: 0 });
        if (at >= 0) {
          try { seen = JSON.parse(text.slice(at + marker.length)); } catch {}
        }
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
            Buffer.byteLength(body) + "\r\n\r\n" + body
        );
      });
    });

    await rotateEgress("rate429", { proxyUrl: SLOT_A, retryAfterMs: 43200 * 1000 });

    expect(seen).not.toBeNull();
    expect(seen.retry_after_ms).toBe(43200 * 1000);
    expect(seen.reason).toBe("rate429");
  });

  it("converts avoid_port_until to epoch ms", async () => {
    const untilSec = Math.floor(Date.now() / 1000) + 30;
    await serveOnce({ ok: true, switched: false, reason: "coalesced", avoid_port_until: untilSec });

    const result = await rotateEgress("rate429", { proxyUrl: SLOT_A });

    expect(result.avoidPortUntil).toBe(untilSec * 1000);
  });

  it("keeps the port when asip cannot tell which line it is (line_unknown)", async () => {
    // 并发抢锁失败：line 身份不可信，但那台健康进程的名字照样可给。
    await serveOnce({
      ok: true,
      line_unknown: true,
      reason: "coalesced",
      switch_to_url: SLOT_B,
      avoid_port_until: 0,
    });

    const result = await rotateEgress("rate429", { proxyUrl: SLOT_A });

    expect(result.lineUnknown).toBe(true);
    expect(result.switchToUrl).toBe(SLOT_B);
    expect(result.lineChanged).toBe(false);
  });

  it("cools the failed port before waiting for asip", async () => {
    // asip 没在跑（连不上）：本地也必须立刻避开这个端口，否则下一条新请求
    // 还会选中它，把同一个 429 演一遍。
    const result = await rotateEgress("rate429", { proxyUrl: SLOT_A });

    expect(result.reason).toBe("socket");
    expect(isAsipProxyCooling(SLOT_A)).toBe(true);
    // 另一台进程不该被连坐。
    expect(isAsipProxyCooling(SLOT_B)).toBe(false);
  });

  it("does not cool the port for reasons that are not egress faults", async () => {
    // 只有 rate429 / abuse403 / transport 才说明「这个端口刚出错」。其余原因
    // （手动换线等）把它关进冷却，等于凭空调走一条好出口。
    await serveOnce({ ok: true, switched: true, reason: "ok", active_tag: "WG-7", active_egress: "1.1.1.1" });

    await rotateEgress("manual", { proxyUrl: SLOT_A });

    expect(isAsipProxyCooling(SLOT_A)).toBe(false);
  });

  it("releases the port when asip proves the line is fine", async () => {
    markAsipProxyCooling(SLOT_A);
    expect(isAsipProxyCooling(SLOT_A)).toBe(true);
    await serveOnce({ ok: false, reason: "line_ok", active_tag: "WG-7", active_egress: "1.1.1.1" });

    await rotateEgress("rate429", { proxyUrl: SLOT_A });

    // asip 用同一份指纹实测这条线仍可用：提前放出来，别白等 15s。
    expect(isAsipProxyCooling(SLOT_A)).toBe(false);
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


describe("no healthy slot -> 9router restarts itself", () => {
  const reply = (body) => (socket) => {
    socket.on("data", () => {
      const payload = JSON.stringify(body);
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
          Buffer.byteLength(payload) + "\r\n\r\n" + payload
      );
    });
  };

  beforeEach(() => {
    // 双保险：即便上面那组环境变量判断漏了，测试也绝不真退进程。
    process.env.ASIP_SELF_RESTART_DISABLED = "1";
    resetAsipSelfRestartForTest();
  });

  afterAll(() => {
    delete process.env.ASIP_SELF_RESTART_DISABLED;
    resetAsipSelfRestartForTest();
  });

  it("asks for a self-restart and does not retry on a dead gate", async () => {
    await listen(reply({
      ok: true, switched: false, reason: "ok", switched_at: 0,
      line_unknown: true, restart_required: true,
      switch_to: null, switch_to_url: null,
      active_tag: "WARP-A", active_egress: "2606:a::1",
      avoid_port_until: 0,
    }));
    const result = await rotateEgress("rate429", {
      proxyUrl: "http://127.0.0.1:7890",
    });
    expect(result.restartRequired).toBe(true);
    expect(result.lineUnknown).toBe(true);
    expect(result.reason).toBe("no_healthy_slot");
    expect(result.switchToUrl).toBe(null);
    expect(result.lineChanged).toBe(false);
    clearAsipProxyCooling("http://127.0.0.1:7890");
  });

  it("does not restart when asip actually offered a standby port", async () => {
    // 矛盾回包（两个信号同时给）以可用端口为准：有落点就不必重启。
    await listen(reply({
      ok: true, switched: true, reason: "ok", switched_at: 0,
      line_unknown: true, restart_required: true,
      switch_to: "slot-4", switch_to_url: "http://127.0.0.1:7894",
      active_tag: "WARP-A", active_egress: "2606:a::1",
      avoid_port_until: 0,
    }));
    const result = await rotateEgress("rate429");
    expect(result.restartRequired).toBe(false);
    expect(result.switchToUrl).toBe("http://127.0.0.1:7894");
  });

  it("throttles repeated restart requests inside one 429 storm", () => {
    expect(requestAsipSelfRestart(1_000_000)).toBe(true);
    expect(requestAsipSelfRestart(1_001_000)).toBe(false);
    expect(requestAsipSelfRestart(1_061_000)).toBe(true);
  });

  it("keeps the throttle across a process restart", () => {
    // 线上 19:52:25 重启后新进程内存归零，19:52:39 又能重启一次。
    // 落盘时间戳必须跨进程生效。
    const stateFile = path.join(DIR, "self-restart.json");
    process.env.ASIP_SELF_RESTART_STATE_FILE = stateFile;
    try {
      expect(requestAsipSelfRestart(2_000_000)).toBe(true);
      expect(fs.existsSync(stateFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).at).toBe(2_000_000);

      // 模拟 process.exit(1) 后的新进程：只剩落盘状态。
      resetAsipSelfRestartMemoryForTest();
      expect(requestAsipSelfRestart(2_001_000)).toBe(false);
      // 满 60s 之后才允许下一次。
      expect(requestAsipSelfRestart(2_061_000)).toBe(true);
    } finally {
      delete process.env.ASIP_SELF_RESTART_STATE_FILE;
      try {
        fs.unlinkSync(stateFile);
      } catch {
        // ignore
      }
      resetAsipSelfRestartForTest();
    }
  });
});


describe("rotate trace log carries req / line / ip / verdict", () => {
  const reply = (body) => (socket) => {
    socket.on("data", () => {
      const payload = JSON.stringify(body);
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
          Buffer.byteLength(payload) + "\r\n\r\n" + payload
      );
    });
  };

  it("prints the offending egress and its probe verdict in one line", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await listen(reply({
        ok: true,
        switched: true,
        reason: "ok",
        offending_tag: "WARP-CF-H",
        offending_egress: "2a09:bac5:1f05:28::4:36f",
        offending_verdict: "quota",
        switch_to: "slot-2",
        switch_to_tag: "WARP-H2-FRA-76",
        switch_to_egress: "2a09:bac5:2a93:18f0::27c:7c",
        switch_to_url: "http://127.0.0.1:7893",
      }));
      await rotateEgress("rate429", { reqId: "REQ-TRACE-9" });
      const line = spy.mock.calls
        .map((args) => args.join(" "))
        .find((msg) => msg.includes("[ASIP] rotate req=REQ-TRACE-9"));
      expect(line).toBeTruthy();
      expect(line).toContain("line=WARP-CF-H");
      expect(line).toContain("ip=2a09:bac5:1f05:28::4:36f");
      expect(line).toContain("verdict=quota");
      expect(line).toContain("to=slot-2");
      expect(line).toContain("to_line=WARP-H2-FRA-76");
      expect(line).toContain("to_ip=2a09:bac5:2a93:18f0::27c:7c");
      expect(line).toContain("to_url=http://127.0.0.1:7893");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to active_tag/active_egress on older asip replies", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await listen(reply({
        ok: true,
        switched: false,
        reason: "too_frequent",
        active_tag: "WG-7",
        active_egress: "1.1.1.1",
      }));
      await rotateEgress("rate429", { reqId: "REQ-TRACE-OLD" });
      const line = spy.mock.calls
        .map((args) => args.join(" "))
        .find((msg) => msg.includes("[ASIP] rotate req=REQ-TRACE-OLD"));
      expect(line).toContain("line=WG-7");
      expect(line).toContain("ip=1.1.1.1");
      expect(line).toContain("verdict=n/a");
    } finally {
      spy.mockRestore();
    }
  });
});
