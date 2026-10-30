import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isLocalRequest } from "@/dashboardGuard.js";

// DEF-05 假设（#469607）：未设 NINEROUTER_PEER_TOKEN 时 isLocalRequest 恒 false，
// 本机请求于是也带 strictRedirects，自托管 LAN 目标的同源 302 被 Blocked URL 拦掉。
//
// 证伪分两段，缺一不可：
//   A. 真值表 —— token 缺失 / 头伪造 / 经反代 三种情形下 isLocalRequest 的实际取值
//   B. 生产链路 —— 启动方式是否真的会设置 token、包装层是否覆盖客户端同名头
// B 在 scripts/verify_def05_local_request_not_strict.py（需要真进程与端口），
// 这里只钉 A：它是「误走 strict」的必要条件，一旦这里绿了，假设就不成立。

const PEER_TOKEN = "test-peer-token-48-chars-not-a-real-secret";

function request(headers) {
  return { headers: new Headers(headers) };
}

describe("isLocalRequest 真值表（DEF-05 的必要条件）", () => {
  const saved = {};

  beforeEach(() => {
    saved.token = process.env.NINEROUTER_PEER_TOKEN;
    saved.nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.NINEROUTER_PEER_TOKEN;
  });

  afterEach(() => {
    if (saved.token === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
    else process.env.NINEROUTER_PEER_TOKEN = saved.token;
    process.env.NODE_ENV = saved.nodeEnv;
  });

  it("returns false without a peer token, even from a loopback socket", () => {
    // 这条是假设成立的那一半：没有 token 时 isLocalRequest 确实为 false。
    // 它只有在「生产环境真的没有 token」时才会触发 —— 见 B 段。
    expect(
      isLocalRequest(request({ "x-9r-real-ip": "127.0.0.1", "x-9r-peer-token": "anything" })),
    ).toBe(false);
  });

  it("rejects a forged peer token", () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    expect(
      isLocalRequest(request({ "x-9r-real-ip": "127.0.0.1", "x-9r-peer-token": "wrong" })),
    ).toBe(false);
  });

  it("treats a stamped loopback peer as local", () => {
    // 生产走 custom-server.js 时每个请求都长这样 → isLocalRequest 为 true
    // → validate 路由的 hop 是 {}，不带 strictRedirects。
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    expect(
      isLocalRequest(request({ "x-9r-real-ip": "127.0.0.1", "x-9r-peer-token": PEER_TOKEN })),
    ).toBe(true);
  });

  it("returns false when the request came through a reverse proxy", () => {
    // 反代后面那一跳 socket 也是 loopback，不能因此判 local。
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    expect(
      isLocalRequest(
        request({
          "x-9r-real-ip": "127.0.0.1",
          "x-9r-peer-token": PEER_TOKEN,
          "x-9r-via-proxy": "1",
        }),
      ),
    ).toBe(false);
  });

  it("returns false for a non-loopback stamped peer", () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    expect(
      isLocalRequest(request({ "x-9r-real-ip": "8.8.8.8", "x-9r-peer-token": PEER_TOKEN })),
    ).toBe(false);
  });

  it("returns false for a loopback peer whose Origin is not loopback", () => {
    // 浏览器同源策略的对应物：Origin 不是 loopback 就不是本机发起的。
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    expect(
      isLocalRequest(
        request({
          "x-9r-real-ip": "127.0.0.1",
          "x-9r-peer-token": PEER_TOKEN,
          origin: "https://evil.example",
        }),
      ),
    ).toBe(false);
  });

  it("accepts the IPv4-mapped IPv6 form of loopback", () => {
    // 双栈监听会给回 ::ffff:127.0.0.1；按第一个冒号切会把它读成空串。
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    expect(
      isLocalRequest(request({ "x-9r-real-ip": "::ffff:127.0.0.1", "x-9r-peer-token": PEER_TOKEN })),
    ).toBe(true);
  });
});
