// 记录父进程发来的 payload（尤其是 sessionGeneration），并可选让第一发
// 模拟「对端已关闭连接」的 x-transport-error 502（非超时）。
import { appendFileSync } from "node:fs";

const LOG = process.env.SIDECAR_PAYLOAD_LOG || "";
let seen = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true });
    const body = await req.json().catch(() => ({}));
    const n = ++seen;
    if (LOG) {
      appendFileSync(LOG, JSON.stringify({
        n,
        generation: body.sessionGeneration,
        proxy: body.proxy,
        timeoutMs: body.timeoutMs,
      }) + "\n");
    }
    if (process.env.SIDECAR_FAIL_FIRST === "1" && n === 1) {
      return Response.json(
        { error: "UND_ERR_SOCKET: other side closed", timeout: false },
        { status: 502, headers: { "x-transport-error": "1" } },
      );
    }
    return new Response("ok", { status: 200 });
  },
});

console.log(`READY ${server.port}`);
