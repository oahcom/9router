import { afterEach, describe, expect, it, vi } from "vitest";

// REQ-EGR-08：出站凭据只发给「凭据所属主机」，改目的地即视为改信任域。
// 两条面：① provider_options.baseUrl 覆盖目的地（builder 级，无需网络）；
//        ② 上游跨源 302（fetchPublic 跳转接管）。同源两条都必须保留凭据。
const EVIL = "https://attacker.example.net";

// fetchPublic 每一跳都做 DNS 复核；这些 *.example.* 主机在测试里不该触网。
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));
lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);

const { buildSearchRequest } = await import("../../open-sse/handlers/search/callers.js");
const { fetchPublic } = await import("../../src/shared/utils/ssrfGuard.js");

function reqHeaders(request) {
  return new Headers(request.init.headers || {});
}

// 各 provider 把 key 放在哪，是这条需求的全部工作量：只剥 header 会漏掉
// google-pse / searchapi 的 query 凭据。
const PROVIDERS = [
  { id: "serper", baseUrl: "https://google.serper.dev", header: "x-api-key" },
  { id: "exa", baseUrl: "https://api.exa.ai", header: "x-api-key" },
  { id: "xquik", baseUrl: "https://xquik.com/api/v1/x/tweets/search", header: "x-api-key" },
  { id: "perplexity", baseUrl: "https://api.perplexity.ai/search", header: "authorization" },
  { id: "google-pse", baseUrl: "https://www.googleapis.com/customsearch/v1", query: "key", extra: { cx: "cx-1" } },
  { id: "searchapi", baseUrl: "https://www.searchapi.io/api/v1/search", query: "api_key" },
];

describe("REQ-EGR-08 AC-08a: baseUrl 覆盖到别的 origin 时不带凭据", () => {
  for (const p of PROVIDERS) {
    it(`${p.id}: 覆盖目的地后 header 与 query 都不含 key`, () => {
      const req = buildSearchRequest({ id: p.id, baseUrl: p.baseUrl }, {
        query: "q", maxResults: 5, token: "SECRET-KEY",
        providerOptions: { baseUrl: EVIL, ...(p.extra || {}) },
      });
      const h = reqHeaders(req);
      expect(h.get("authorization"), "authorization 不得外送").toBeNull();
      expect(h.get("cookie"), "cookie 不得外送").toBeNull();
      expect(h.get("x-api-key"), "x-api-key 不得外送").toBeNull();
      expect(h.get("x-subscription-token"), "x-subscription-token 不得外送").toBeNull();
      const qp = new URL(req.url).searchParams;
      expect(qp.get("key"), "query 里的 key 不得外送").toBeNull();
      expect(qp.get("api_key"), "query 里的 api_key 不得外送").toBeNull();
      expect(req.url, "请求本身仍应发到覆盖后的主机").toContain("attacker.example.net");
    });
  }
});

describe("REQ-EGR-08 AC-08a 反向：同源请求必须保留凭据", () => {
  for (const p of PROVIDERS) {
    it(`${p.id}: 不改目的地时凭据照常带上`, () => {
      const req = buildSearchRequest({ id: p.id, baseUrl: p.baseUrl }, {
        query: "q", maxResults: 5, token: "SECRET-KEY",
        providerOptions: { ...(p.extra || {}) },
      });
      const h = reqHeaders(req);
      const fromHeader = p.header ? h.get(p.header) : null;
      const fromQuery = p.query ? new URL(req.url).searchParams.get(p.query) : null;
      expect(fromHeader || fromQuery, "同源凭据不得被一刀切剥掉").toContain("SECRET-KEY");
    });
  }
});

describe("REQ-EGR-08 AC-08b: fetchPublic 跨源 302 第二跳不带凭据", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function stubChain(secondHopUrl) {
    const inits = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      inits.push({ url: String(url), headers: new Headers(init?.headers || {}) });
      return String(url) === "https://hop1.example.com/a"
        ? new Response(null, { status: 302, headers: { location: secondHopUrl } })
        : new Response("ok", { status: 200 });
    });
    return inits;
  }

  it("跨源 302：第二跳 authorization/cookie/x-api-key/x-subscription-token 全为 null", async () => {
    const inits = stubChain("https://elsewhere.example.net/steal");
    await fetchPublic("https://hop1.example.com/a", {
      headers: { authorization: "Bearer SECRET", cookie: "sid=1", "x-api-key": "K", "x-subscription-token": "S", "x-trace": "keep" },
    });
    expect(inits).toHaveLength(2);
    expect(inits[0].headers.get("authorization")).toBe("Bearer SECRET");
    for (const name of ["authorization", "cookie", "x-api-key", "x-subscription-token"]) {
      expect(inits[1].headers.get(name), `${name} 不得跟着跨源跳转`).toBeNull();
    }
    expect(inits[1].headers.get("x-trace"), "剥的是凭据，不是整个 headers").toBe("keep");
  });

  it("同源 302：凭据原样保留（不一刀切）", async () => {
    const inits = stubChain("/b");
    await fetchPublic("https://hop1.example.com/a", { headers: { authorization: "Bearer SECRET" } });
    expect(inits).toHaveLength(2);
    expect(inits[1].headers.get("authorization")).toBe("Bearer SECRET");
  });

  it("连跳两跳跨源：第二跳起就不该还带着", async () => {
    const inits = [];
    const hops = {
      "https://h1.example.com/": "https://h2.example.net/",
      "https://h2.example.net/": "https://h3.example.org/",
    };
    globalThis.fetch = vi.fn(async (url, init) => {
      inits.push({ url: String(url), headers: new Headers(init?.headers || {}) });
      const next = hops[String(url)];
      return next
        ? new Response(null, { status: 302, headers: { location: next } })
        : new Response("ok", { status: 200 });
    });
    await fetchPublic("https://h1.example.com/", { headers: { authorization: "Bearer SECRET" } });
    expect(inits).toHaveLength(3);
    expect(inits[1].headers.get("authorization")).toBeNull();
    expect(inits[2].headers.get("authorization")).toBeNull();
  });
});

describe("REQ-EGR-08 接缝：跨源剥凭据不得把 Content-Type 一起剥掉", () => {
  // 上面两组各自正确却互相看不见：callers 的跨源分支返回 Headers，
  // index.js 的 sanitizeHeaders 用 Object.entries 遍历 → Headers 无可枚举
  // 自有属性 → {}，整排头（含 Content-Type）消失，JSON body 变成无类型的
  // 请求体。检测只查「凭据在不在」，故 16 个用例全绿也抓不到。
  // 这一条必须走 handleSearchCore 而不是自己 new Headers() 压平类型。
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("跨源覆盖：Content-Type 仍在、凭据已剥、body 仍是 JSON", async () => {
    const sent = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers || {}), body: init?.body });
      return new Response(JSON.stringify({ organic: [{ title: "t", link: "https://x.example", snippet: "s" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    const { handleSearchCore } = await import("../../open-sse/handlers/search/index.js");
    const result = await handleSearchCore({
      body: { query: "q", provider_options: { baseUrl: EVIL } },
      provider: { id: "serper" },
      providerConfig: { baseUrl: "https://google.serper.dev", method: "POST", authType: "apikey",
        authHeader: "x-api-key", searchTypes: ["web"], defaultMaxResults: 5, maxMaxResults: 100, timeoutMs: 10000 },
      credentials: { apiKey: "SECRET-KEY" },
      log: null,
    });
    expect(result.success, "上游 200 + 可解析结果应判成功").toBe(true);
    expect(sent, "应当且只应当发出一次请求").toHaveLength(1);
    expect(sent[0].headers.get("content-type"), "丢 Content-Type 会让上游按非 JSON 解析 body").toBe("application/json");
    expect(sent[0].headers.get("x-api-key"), "覆盖目的地后凭据不得外送").toBeNull();
    expect(JSON.parse(sent[0].body).q, "body 仍应是被测查询").toBe("q");
  }, 15000); // 接缝走 handleSearchCore 全链路，16 worker 下实测 5095.8ms 超 5000ms 默认值；单跑 0.7~0.9s
});

describe("REQ-EGR-08 AC-08c: 两条路径共用一处定义", () => {
  it("stripCredentialsForCrossOrigin 只有一份实现", async () => {
    const { readFileSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const out = execSync(
      "command grep -rc 'function stripCredentialsForCrossOrigin' open-sse/utils/proxyFetch.js src/shared/utils/ssrfGuard.js open-sse/handlers/search/callers.js",
      { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" },
    );
    const total = out.trim().split("\n")
      .map((line) => Number(line.split(":").pop()))
      .reduce((a, b) => a + b, 0);
    expect(total, "两份实现 = 改一处漏一处").toBe(1);
    // proxyFetch 必须是 import，不是自己再写一份。
    const src = readFileSync(new URL("../../open-sse/utils/proxyFetch.js", import.meta.url), "utf8");
    expect(src).toMatch(/import \{[^}]*stripCredentialsForCrossOrigin[^}]*\} from "\.\.\/\.\.\/src\/shared\/utils\/ssrfGuard\.js"/);
  });
});
