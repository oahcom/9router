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
// 另一个 origin 的公网地址：跨源跳转要剥凭据，同源要保留，两者都得有对照。
const OTHER_ORIGIN = "http://1.1.1.1/elsewhere";
// 局域网对等体：首跳闸门有意放行（proxyResolution.js 的 isPrivateHost 注释），
// 第 N 跳必须与首跳同判据，否则同源 302 会把自托管服务整类掐断。
const LAN = "http://192.168.1.97:20127/";
const BLOCKED = /refused (link-local\/metadata|host resolving to link-local\/metadata)/;

let sent;
let sentInits; // 每一跳的 init，用来断言 headers 有没有被剥
let nextHop; // (url) => Response
let proxyAwareFetch;
let realFetch;

beforeAll(async () => {
  realFetch = globalThis.fetch;
  sent = [];
  sentInits = [];
  nextHop = () => new Response(null, { status: 302, headers: { location: METADATA } });
  globalThis.fetch = async (url, init) => {
    sent.push(String(url));
    sentInits.push(init ?? {});
    return nextHop(String(url));
  };
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function stub(impl) {
  sent.length = 0;
  sentInits.length = 0;
  nextHop = impl;
}

function headerOf(hop, name) {
  const h = sentInits[hop]?.headers;
  if (!h) return null;
  return h instanceof Headers ? h.get(name) : new Headers(h).get(name);
}

describe("proxyAwareFetch: 重定向逐跳复核", () => {
  it("refuses a 302 that points at a link-local metadata address", async () => {
    stub(() => new Response(null, { status: 302, headers: { location: METADATA } }));
    await expect(proxyAwareFetch(REAL_GET)).rejects.toThrow(BLOCKED);
    // 第二跳从未发出：拦截发生在 fetch 之前，不是「发了再判断」。
    expect(sent).toEqual([REAL_GET]);
  });

  // 第 N 跳走的就是首跳那道闸门，所以「名字解析到元数据」的 DNS 判据不必在这里
  // 用真 DNS 重测一遍：那个用例在满负载下会因 RESOLVE_TIMEOUT_MS=1500 的
  // fail-open 而偶发变绿（实测 431 文件并行跑时红过一次）。确定性的解析用例在
  // local-target-bypasses-env-proxy.test.js（注入 lookup），这里只钉「跳转目标是
  // 否重新过闸」本身。字面量元数据拦截见上一个用例。

  it("follows a same-origin 302 on a LAN peer", async () => {
    // 回归护栏：第 N 跳改用 ssrfGuard（一律拒私有）时，这里会抛
    // `Blocked URL: internal host`，自托管 ollama/headroom 回一个补斜杠的
    // 302 就整类不可用（wf_sub_eb15773af4ad 的 DEF-01）。
    stub((u) => (u === LAN
      ? new Response(null, { status: 302, headers: { location: "/v1/models" } })
      : new Response("SELF-HOSTED-OK", { status: 200 })));
    const res = await proxyAwareFetch(LAN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SELF-HOSTED-OK");
    expect(sent).toEqual([LAN, "http://192.168.1.97:20127/v1/models"]);
  });

  it("returns the 3xx instead of a bare TypeError when location is unparseable", async () => {
    stub(() => new Response(null, { status: 302, headers: { location: "http://[::bad::url]/" } }));
    const res = await proxyAwareFetch(REAL_GET);
    expect(res.status).toBe(302);
    expect(sent).toEqual([REAL_GET]);
  });

  it("strictRedirects re-checks hops with the full private-range verdict", async () => {
    // 远程可达路由（cowork-mcp-tools / provider-nodes validate）传这个开关：
    // 首跳闸门放行局域网是给本机自托管用的，远程调用方不该继承。
    stub((u) => (u === REAL_GET
      ? new Response(null, { status: 302, headers: { location: LAN } })
      : new Response("ok", { status: 200 })));
    await expect(proxyAwareFetch(REAL_GET, { strictRedirects: true })).rejects.toThrow(/Blocked URL/);
    expect(sent).toEqual([REAL_GET]);
  });

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

  // DEF-04：接管跳转后 headers 整份沿用，跨源 302 会把 Authorization/Cookie
  // 送给第三方。原生 fetch 自己会剥（undici 的 CORS non-wildcard 分支），
  // 我们绕过了它，就得自己剥。
  it("strips credentials when a 302 crosses to another origin", async () => {
    stub((u) => (u === REAL_GET
      ? new Response(null, { status: 302, headers: { location: OTHER_ORIGIN } })
      : new Response("ok", { status: 200 })));
    await proxyAwareFetch(REAL_GET, {
      headers: { authorization: "Bearer SECRET", cookie: "sid=secret", "x-trace": "keep-me" },
    });
    expect(sent).toEqual([REAL_GET, OTHER_ORIGIN]);
    expect(headerOf(0, "authorization")).toBe("Bearer SECRET");
    expect(headerOf(1, "authorization")).toBeNull();
    expect(headerOf(1, "cookie")).toBeNull();
    // 非凭据头照常转发：剥的是凭据，不是整个 headers。
    expect(headerOf(1, "x-trace")).toBe("keep-me");
  });

  it("keeps credentials on a same-origin 302", async () => {
    // 自托管服务补斜杠的 302 不能因此丢 auth（DEF-01 的回归护栏）。
    stub((u) => (u === REAL_GET
      ? new Response(null, { status: 302, headers: { location: "/v2/models" } })
      : new Response("ok", { status: 200 })));
    await proxyAwareFetch(REAL_GET, { headers: { authorization: "Bearer SECRET" } });
    expect(sent).toEqual([REAL_GET, "http://example.com/v2/models"]);
    expect(headerOf(1, "authorization")).toBe("Bearer SECRET");
  });

  it("strips credentials on a cross-origin 307 too", async () => {
    // 307 保留 method/body，headers 走的是另一条分支，同样要剥。
    stub((u) => (u === REAL_GET
      ? new Response(null, { status: 307, headers: { location: OTHER_ORIGIN } })
      : new Response("ok", { status: 200 })));
    await proxyAwareFetch(REAL_GET, {
      method: "POST",
      body: "payload",
      headers: { authorization: "Bearer SECRET" },
    });
    expect(sent).toEqual([REAL_GET, OTHER_ORIGIN]);
    expect(headerOf(1, "authorization")).toBeNull();
  });

  it("accepts a Headers instance and still strips on cross-origin", async () => {
    // 调用方传 Headers 实例时 `{...options}` 浅拷贝共用同一引用，改它等于改调用方的对象。
    stub((u) => (u === REAL_GET
      ? new Response(null, { status: 302, headers: { location: OTHER_ORIGIN } })
      : new Response("ok", { status: 200 })));
    const headers = new Headers({ authorization: "Bearer SECRET" });
    await proxyAwareFetch(REAL_GET, { headers });
    expect(headerOf(1, "authorization")).toBeNull();
    // 调用方手里的对象不能被就地改掉。
    expect(headers.get("authorization")).toBe("Bearer SECRET");
  });
});
