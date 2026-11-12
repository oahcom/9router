// 第七闸口（代理池兜底）在 9router 侧的接线：
//  1. 7897 能触发 asip 换线，但绝不进常规轮询端口池（严格兜底）；
//  2. asip 回包的池节点身份要透传，[ASIP] rotate 日志要能看见 to_node=。
// 守卫的「池节点变化即重放」由 opencode-asip-rotate.test.js 覆盖。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "asip-gate-"));
const SOCK = path.join(DIR, "rotate.sock");
const TOKEN_FILE = path.join(DIR, "api-token");

// 用源码默认端口集合，避免测试环境里的覆盖把结论带上别的机器的配置。
delete process.env.ASIP_LOCAL_PROXY_PORT;
delete process.env.ASIP_PROXY_GATE_PORT;
process.env.ASIP_SOCKET = SOCK;
process.env.ASIP_TOKEN_FILE = TOKEN_FILE;
process.env.ASIP_TIMEOUT_MS = "500";
delete process.env.ASIP_DISABLED;

const { rotateEgress, forgetActiveLine } = await import(
  "../../open-sse/utils/asipRotate.js");
const { isAsipRotatablePort, ASIP_PROXY_PORTS } = await import(
  "../../open-sse/utils/proxyFetch.js");

let server = null;
const sockets = new Set();

function respondWith(payload) {
  return new Promise((resolve) => {
    try { fs.unlinkSync(SOCK); } catch {}
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\r\n\r\n")) return;
        const body = JSON.stringify(payload);
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
          "Content-Length: " + Buffer.byteLength(body) + "\r\n" +
          "Connection: close\r\n\r\n" + body);
        socket.end();
      });
    });
    server.listen(SOCK, () => resolve());
  });
}

beforeEach(() => {
  fs.writeFileSync(TOKEN_FILE, "test-token", { mode: 0o600 });
  forgetActiveLine();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) { server.close(); server = null; }
  try { fs.unlinkSync(SOCK); } catch {}
});

afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

describe("第七闸口：可换线，但不进常规轮询池", () => {
  it("7897 放行换线，却不在 ASIP_PROXY_PORTS 里", () => {
    expect(isAsipRotatablePort("7897")).toBe(true);
    expect(isAsipRotatablePort("7896")).toBe(true);
    expect(isAsipRotatablePort("7891")).toBe(false);
    expect(isAsipRotatablePort("18080")).toBe(false);
    expect(ASIP_PROXY_PORTS.has("7897"), "兜底闸不能被放进常规轮询").toBe(false);
  });
});

describe("第七闸口：asip 回包的池节点身份", () => {
  it("透传 switch_to_node，并把 to_node= 写进 [ASIP] rotate 日志", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await respondWith({
      ok: true, switched: true, reason: "ok",
      switched_at: Date.now() / 1000,
      active_tag: "pool-node-1", active_egress: null,
      switch_to: "slot-7",
      switch_to_url: "http://127.0.0.1:7897",
      switch_to_tag: "pool-node-2", switch_to_egress: null,
      switch_to_node: "pool-node-2",
    });

    const res = await rotateEgress("rate429", {
      proxyUrl: "http://127.0.0.1:7897",
      reqId: "gate-test-1",
    });

    expect(res.switchToNode).toBe("pool-node-2");
    expect(res.switchToUrl).toBe("http://127.0.0.1:7897");
    expect(res.switchedAt).toBeGreaterThan(0);
    expect(res.switchToEgress).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("to_node=pool-node-2");
  });
});
