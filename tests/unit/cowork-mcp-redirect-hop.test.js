/**
 * DEF-02 回归：cowork-mcp-tools 的探针不再跟随 30x 到内网（wf_sub_eb15773af4ad）。
 *
 * 路由原先用裸 `fetch(url, …)`（默认跟随重定向），首跳闸门只判一次 ——
 * 远程调用方指向自己的公网主机、回 302 到元数据即可绕过。现在走
 * proxyAwareFetch 并带 strictRedirects。
 *
 * proxyFetch 在模块顶层抓一次 `globalThis.fetch`，所以桩必须在 import 路由之前装好
 * （与 proxy-redirect-hop-guard.test.js 同一手法）。
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

// 公网 IP 字面量：闸门对字面量不做 DNS，用例不随解析抖动（实测 example.com
// 在并行跑测试时会触发 RESOLVE_TIMEOUT_MS 并撞上 vitest 的 5s 上限）。
const PUBLIC = "http://8.8.8.8/mcp";
const METADATA = "http://169.254.169.254/latest/meta-data/";

let sent;
let POST;

beforeAll(async () => {
  sent = [];
  // 桩必须复刻原生 fetch 的「默认跟随」语义，否则它既不代表改前的裸 fetch，
  // 也不代表改后的 manual 逐跳：改前这条用例会在旧代码上照样变绿（无意义）。
  globalThis.fetch = async (url, init = {}) => {
    sent.push(String(url));
    if (init.redirect === "manual") {
      return new Response(null, { status: 302, headers: { location: METADATA } });
    }
    // 默认跟随：把 302 链自己走完（原生 fetch 的行为）
    return new Response("METADATA-SECRET", { status: 200 });
  };
  ({ POST } = await import("../../src/app/api/cli-tools/cowork-mcp-tools/route.js"));
});

function remoteRequest(url) {
  return new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("cowork-mcp-tools: 30x 到内网", () => {
  it("does not follow a redirect into the metadata endpoint", async () => {
    sent.length = 0;
    const res = await POST(remoteRequest(PUBLIC));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 改前：裸 fetch 自动跟到元数据，探针拿到 200 正文（这是被利用的形态）
    expect(JSON.stringify(body)).not.toContain("METADATA-SECRET");
    // 闸门在第二跳 fetch 之前就拒了：只有首跳发出过。
    expect(sent).toEqual([PUBLIC]);
  });
});
