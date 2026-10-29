import { describe, it, expect, beforeAll, afterAll } from "vitest";

// #466798 §三c 验收：302 跳转到元数据地址，在 proxyAwareFetch 路径上必须被拒。
//
// 入口闸门 assertEgressTargetAllowed 只复核**首跳**，30x 之后的目标从不重查
// （proxyResolution.js 的注释写明了这个边界）。这里把 globalThis.fetch 换成
// 可编程的桩，让首跳是合法地址、第二跳才是元数据地址 —— 走真实调用路径，
// 不把私有函数抠出来单测。
//
// 注意桩必须在 import 之前装：proxyFetch.js 在模块顶层 `const originalFetch =
// globalThis.fetch` 抓走一次，之后改 globalThis.fetch 对它无效。所以桩里读
// 可变变量，而不是每个用例重装 globalThis.fetch。

const REAL_GET = "http://example.com/";
const METADATA = "http://169.254.169.254/latest/meta-data/";
const SAFE = "http://8.8.8.8/next"; // 公网 IP 字面量：不依赖 DNS，也不会撞 RFC1918

let sent;
let nextHop; // (url) => Response
let proxyAwareFetch;
let realFetch;

beforeAll(async () => {
  realFetch = globalThis.fetch;
  sent = [];
  nextHop = () => new Response(null, { status: 302, headers: { location: METADATA } });
  globalThis.fetch = async (url) => {
    sent.push(String(url));
    return nextHop(String(url));
  };
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function stub(impl) {
  sent.length = 0;
  nextHop = impl;
}

describe("proxyAwareFetch: 重定向逐跳复核", () => {
  it("refuses a 302 that points at a link-local metadata address", async () => {
    stub(() => new Response(null, { status: 302, headers: { location: METADATA } }));
    await expect(proxyAwareFetch(REAL_GET)).rejects.toThrow(/Blocked URL/);
    // 第二跳从未发出：拦截发生在 fetch 之前，不是「发了再判断」。
    expect(sent).toEqual([REAL_GET]);
  });

  it("refuses a 302 that points at a nip.io alias of the same address", async () => {
    stub(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254.nip.io/" } }));
    await expect(proxyAwareFetch(REAL_GET)).rejects.toThrow(/Blocked URL/);
    expect(sent).toEqual([REAL_GET]);
    // 真实 DNS 查询，不走 mock：本机实测同一域名 250ms~5.3s 抖动。
  }, 30000);

  it("follows a 302 to a public address", async () => {
    stub((u) => (u === REAL_GET
      ? new Response(null, { status: 302, headers: { location: SAFE } })
      : new Response("ok", { status: 200 })));
    const res = await proxyAwareFetch(REAL_GET);
    expect(await res.text()).toBe("ok");
    expect(sent).toEqual([REAL_GET, SAFE]);
  });

  it("leaves redirect:'manual' callers alone", async () => {
    stub(() => new Response(null, { status: 302, headers: { location: SAFE } }));
    const res = await proxyAwareFetch(REAL_GET, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(sent).toEqual([REAL_GET]);
  });
});
