// 需要 Bun sidecar 的用例：没有 bun 的机器上 skip，别变成「基线之外的新失败」。
const HAS_BUN = globalThis.__HAS_BUN__ !== false;

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";

// 用真 Bun sidecar + 真 HTTP 上游跑：退役语义的风险全在进程生命周期上，
// mock 掉进程就什么都测不到。
process.env.OPENCODE_TRANSPORT = "auto";
process.env.OPENCODE_BUN_BIN = process.env.OPENCODE_BUN_BIN || "bun";
// sidecar 路径默认按 cwd 解析，vitest 的 cwd 是 tests/。
process.env.OPENCODE_TRANSPORT_SCRIPT =
  path.resolve(import.meta.dirname, "../../scripts/opencode-transport.mjs");

const { fetchViaTransport, resetTransport } = await import("../../open-sse/utils/opencodeTransport.js");

// 立刻回头，然后慢慢吐完 N 个 chunk —— 复刻 SSE 在途形态。
// 只看 status 区分不出修复前后：被打断的请求会重试到新 sidecar 并拿到头。
// 真正的伤害在 body 上，帧已经发给客户端，重试救不回来。
function startStreamingUpstream(chunks, gapMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks) {
          clearInterval(timer);
          res.end("data: done\n\n");
          return;
        }
        res.write(`data: chunk${i++}\n\n`);
      }, gapMs);
      res.on("close", () => clearInterval(timer));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      close: () => server.close(),
    }));
  });
}

describe.skipIf(!HAS_BUN)("sidecar retirement", () => {
  let upstream;

  beforeEach(async () => {
    resetTransport();
    upstream = await startStreamingUpstream(20, 300); // ~6s 的流
  });

  afterEach(() => {
    upstream?.close();
    resetTransport();
  });

  it("does not truncate an in-flight stream when another request fails", async () => {
    const stream = fetchViaTransport(
      `http://127.0.0.1:${upstream.port}/slow`,
      { method: "POST", headers: {}, body: '{"stream":true}' },
      { enabled: true, url: null },
    );

    // 等 SSE 真正开始流式输出，再制造一条立刻失败的请求。
    const response = await stream;
    expect(response, "流式请求本身不该失败").not.toBeNull();
    expect(response.status).toBe(200);

    const bodyPromise = response.text();
    await new Promise((r) => setTimeout(r, 700));

    // 代理指向本机 SSH 端口：能建连但不讲 HTTP，sidecar 立刻回 502
    // x-transport-error —— 这正是会走 retire() 的那条分支。
    const failed = await fetchViaTransport(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", headers: {}, body: '{"stream":true}' },
      { enabled: true, url: "http://127.0.0.1:22" },
    );
    expect(failed === null || failed.status >= 500, `坏请求返回 ${failed?.status}`).toBe(true);

    // 修复前 retire 会 SIGKILL 共享 sidecar：这条流的 body 被截断，
    // 客户端看到半截响应。修复后它应当完整跑完。
    const body = await bodyPromise;
    expect(body, "在途流被截断（sidecar 被 SIGKILL）").toContain("data: done");
  }, 40000);
});
