// 槽位端口短冷却：asip 报某个端口 429/transport 后，新请求在窗口内跳过它。
//
// 为什么按「规范化代理 URL」而不是 poolId：同一个 sing-box 端口可能被多个池或
// 连接引用（7890 与 7892 是两台独立进程，但 a.example:7892 与 b.example:7892
// 是两条不同出口）。按 poolId 记会让「换个池名」绕过冷却，按原始字符串记又会
// 让 "http://127.0.0.1:7892/" 与 "http://127.0.0.1:7892" 变成两个键。
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearAsipProxyCooling,
  isAsipProxyCooling,
  markAsipProxyCooling,
} from "../../open-sse/utils/asipRotate.js";

// 与生产同一批槽位端口（7890 是主出口，7892-7896 是 consumer slot）。
const P7890 = "http://127.0.0.1:7890";
const P7892 = "http://127.0.0.1:7892";

beforeEach(() => {
  clearAsipProxyCooling(P7890);
  clearAsipProxyCooling(P7892);
});

describe("asip slot proxy cooldown", () => {
  it("cools only the port that reported the failure", () => {
    markAsipProxyCooling(P7892);

    expect(isAsipProxyCooling(P7892)).toBe(true);
    // 同一台机器上的另一个端口是另一个 sing-box 进程、另一条出口：
    // 一起冷却会把整池挡掉，退化成直连。
    expect(isAsipProxyCooling(P7890)).toBe(false);
  });

  it("treats trailing-slash and case variants as the same port", () => {
    markAsipProxyCooling("HTTP://127.0.0.1:7892/");

    expect(isAsipProxyCooling(P7892)).toBe(true);
  });

  it("expires on its own TTL without an explicit answer from asip", () => {
    const until = markAsipProxyCooling(P7892);

    expect(Number.isFinite(until)).toBe(true);
    expect(isAsipProxyCooling(P7892, until - 1)).toBe(true);
    // 到点即放行：asip 没回话时不能永久关掉一个端口。
    expect(isAsipProxyCooling(P7892, until + 1)).toBe(false);
  });

  it("honours asip's avoid_port_until instead of the local default", () => {
    const now = Date.now();
    const wanted = now + 3_000;
    const until = markAsipProxyCooling(P7892, wanted);

    expect(until - wanted).toBeLessThan(50);
    expect(isAsipProxyCooling(P7892, now + 1_000)).toBe(true);
    expect(isAsipProxyCooling(P7892, now + 4_000)).toBe(false);
  });

  it("never shortens an existing window", () => {
    // 并发请求会各自收到回包，旧的、新的都可能最后到达。若允许缩短，
    // 一个迟到的「早就该过期」的回包会把坏端口提前放回轮询。
    const now = Date.now();
    const far = now + 20_000;
    markAsipProxyCooling(P7892, far);
    const until = markAsipProxyCooling(P7892, now + 1_000);

    expect(until).toBe(far);
    expect(isAsipProxyCooling(P7892, now + 5_000)).toBe(true);
  });

  it("caps an absurd window so a bad clock cannot park a port forever", () => {
    const now = Date.now();
    const until = markAsipProxyCooling(P7892, now + 60 * 60 * 1000);

    expect(until - now).toBeLessThanOrEqual(60_000);
  });

  it("clears a port when asip proves the line is fine", () => {
    markAsipProxyCooling(P7892);
    clearAsipProxyCooling(P7892);

    expect(isAsipProxyCooling(P7892)).toBe(false);
  });

  it("ignores empty urls instead of cooling a shared empty key", () => {
    expect(markAsipProxyCooling("")).toBe(0);
    expect(isAsipProxyCooling("")).toBe(false);
    expect(isAsipProxyCooling(null)).toBe(false);
  });
});
