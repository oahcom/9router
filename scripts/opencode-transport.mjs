const token = process.env.OPENCODE_TRANSPORT_TOKEN || "";
const port = Number(process.env.OPENCODE_TRANSPORT_PORT || 0);

// 出口只由 payload.proxy 决定。父进程即使没清干净环境变量，这里也不允许
// Bun 的 fetch 把「直连」偷偷换成 env 里配置的代理。
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
  delete process.env[name];
}

function forwardableHeaders(input) {
  const headers = {};
  for (const [key, value] of Object.entries(input || {})) {
    const name = key.toLowerCase();
    if (name === "host" || name === "content-length" || name === "connection") continue;
    if (name === "accept-encoding" || name === "transfer-encoding") continue;
    if (value == null) continue;
    headers[key] = String(value);
  }
  return headers;
}

function responseHeaders(input) {
  const headers = new Headers();
  input.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === "content-encoding" || name === "content-length") return;
    if (name === "transfer-encoding" || name === "connection") return;
    headers.set(key, value);
  });
  return headers;
}

// 响应头超时由父进程按请求类型下发（payload.timeoutMs）：流式给 20s，非流式给 0 =
// 不设限，因为长生成可能在响应头返回前就超过 20s。
// 父进程自己也在同一个 20s 上掐一次，哪个先响取决于事件循环，所以两种超时在
// 上游看起来是同一件事，只在失败标签上分家。
// Bun 的全局 fetch 池会在隧道静默失效后继续复用半开连接，直到内置 ~5min 上限
// （oven-sh/bun#31894）；`keepalive:false` 与裸 Connection: close 都拦不住
// （#14538、#46027）。FetchSession 的 idleTimeout 是唯一有文档的淘汰口：
// 10s 后未用的 socket 被丢弃，下一次请求重建，僵尸池最多影响 10s。
const SESSION_IDLE_TIMEOUT_SEC = 10;
const SESSION_MAX_IDLE_SOCKETS = 8;
// asip 会单方面重启隧道（实测同线重启 p50 22-24s），9router 未必收到换线通知，
// generation 也就不一定变。对端没了、本地 socket 仍 ESTAB，持续流量下 idleTimeout
// 永远不触发 → 僵尸连接被无限复用。给 session 一个硬寿命作为兜底：超龄换新池，
// 已发出的请求仍持有旧 session 对象，不会被掐断。
const SESSION_MAX_AGE_SEC = Math.max(5, Number(process.env.OPENCODE_SESSION_MAX_AGE_SEC || 20));
const sessions = new Map();   // key -> { session, createdAt }

function sessionFor(proxy, generation = 0) {
  // generation 由父进程按端口 bump：出口身份变了，旧连接不再是同一条出口。
  const key = (proxy || "direct") + "|" + generation;
  const now = Date.now();
  let entry = sessions.get(key);
  if (entry && now - entry.createdAt > SESSION_MAX_AGE_SEC * 1000) {
    // 只删表里的引用；在途请求持有的 session 不受影响，旧池靠 idleTimeout 回收。
    sessions.delete(key);
    entry = null;
  }
  if (!entry) {
    const session = new Bun.FetchSession({
      ...(proxy ? { proxy } : {}),
      keepAlive: {
        idleTimeout: SESSION_IDLE_TIMEOUT_SEC,
        maxIdleSockets: SESSION_MAX_IDLE_SOCKETS,
      },
    });
    // 旧 generation 的 session 不会再用到，交给 idleTimeout 淘汰；表只留最近 64 个。
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
    entry = { session, createdAt: now };
    sessions.set(key, entry);
  }
  return entry.session;
}

// 响应头之后，fetch 已经成功，上游 socket 再被重置只会体现为 body 流
// 读失败；直接透传 upstream.body 时这里没有任何日志。包一层 reader，
// 把断流时已读字节数和 reqId 留下来，供父进程转发到 journal。
function observeUpstreamBody(upstream, reqId) {
  if (!upstream.body) return null;
  const reader = upstream.body.getReader();
  const expected = Number(upstream.headers.get("content-length")) || 0;
  const target = String(upstream.url || "").replace(/[\r\n]/g, " ").slice(0, 300);
  let bytes = 0;
  let cancelled = false;
  const detail = () => `req=${reqId} url=${target} bytes=${bytes}${expected ? `/${expected}` : ""}`;
  const release = () => {
    try { reader.releaseLock(); } catch { }
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (expected > 0 && bytes !== expected) {
            console.error(`[OpenCodeTransport] upstream body short read (${detail()})`);
          }
          release();
          controller.close();
          return;
        }
        bytes += value.byteLength;
        controller.enqueue(value);
      } catch (error) {
        if (!cancelled) {
          console.error(`[OpenCodeTransport] upstream body interrupted: ${error?.message || error} (${detail()})`);
        }
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/forward" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    // fail-closed：没有 token 就不服务。父进程总会 randomBytes(24) 生成一个，
    // 缺了只可能是环境没传对 —— 那时候把 sidecar 当开放代理用比不可用更糟。
    if (!token || request.headers.get("x-transport-token") !== token) {
      return new Response("forbidden", { status: 403 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (!payload?.url) return new Response("bad request", { status: 400 });

    const options = {
      method: payload.method || "POST",
      headers: forwardableHeaders(payload.headers),
      body: payload.body ?? undefined,
      redirect: "manual",
    };
    options.headers["accept-encoding"] = "identity";

    // 添加上游请求超时，防止连接卡死导致 9router 侧超时杀掉 sidecar
    const timeoutMs = Number(payload.timeoutMs) || 0;
    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    options.signal = controller.signal;

    let upstream;
    try {
      upstream = await sessionFor(payload.proxy, payload.sessionGeneration).fetch(payload.url, options);
    } catch (error) {
      clearTimeout(timeoutId);
      const msg = String(error?.message || error);
      // 超时或连接错误返回可重试标记。Bun 的 connectTimeout 抛的是
      // TimeoutError("The operation timed out.")，既不是 AbortError 也不含
      // "timeout" 子串——之前落到 502 分支，走的是无节流的 retire()。
      const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError"
        || /timeout|timed out/i.test(msg);
      return Response.json(
        { error: msg, timeout: isTimeout },
        { status: isTimeout ? 504 : 502, headers: { "x-transport-error": "1" } }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const reqId = String(payload.reqId || "-").replace(/[\r\n]/g, " ").slice(0, 80);
    return new Response(observeUpstreamBody(upstream, reqId), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    });
  },
});

console.log(`READY ${server.port}`);

// 父进程死了就自我了断。spawn 它的 node 被 SIGKILL 时（systemd 重启、EADDRINUSE
// 抢端口崩溃）子进程不会跟着走，会被 /init 收养成孤儿，各占一个端口与 ~26MB，
// 且不再被任何 retire/inflight 逻辑管理。实测一个存活 6+ 分钟。
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(0);
}, 2000).unref();
