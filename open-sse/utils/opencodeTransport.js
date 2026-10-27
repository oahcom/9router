import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { OPENCODE_TRANSPORT_CONFIG } from "../config/runtimeConfig.js";
import { normalizeString, resolveEffectiveProxyUrl } from "./proxyResolution.js";

const TRANSPORT_PATH = "/forward";
const SIDECAR = path.join("scripts", "opencode-transport.mjs");
// 退役的 sidecar 最多再活这么久：在途请求若挂住不结束，兜底回收进程。
const RETIRE_MAX_MS = 30000;

let active = null;
let starting = null;
let retryAt = 0;
let startGen = 0;
let lastResetAt = 0;

function available() {
  return OPENCODE_TRANSPORT_CONFIG.mode !== "off" && Date.now() >= retryAt;
}

function sidecarPath() {
  return normalizeString(process.env.OPENCODE_TRANSPORT_SCRIPT) || path.join(process.cwd(), SIDECAR);
}

function block(error) {
  retryAt = Date.now() + OPENCODE_TRANSPORT_CONFIG.failureBackoffMs;
  console.warn(`[OpenCodeTransport] ${error.message}`);
  stop();
}

function killChild(transport) {
  try { transport.child.kill("SIGKILL"); } catch { }
}

function stop() {
  const current = active;
  active = null;
  starting = null;
  startGen++;
  if (current) killChild(current);
}

// 单个请求失败不代表共享 sidecar 该被砍：其余在途的 SSE 还在它上面跑。
// 只摘掉 active（新请求开新进程），旧进程等在途归零再杀。直接 SIGKILL
// 会把并发请求全打成 socket hang up，它们各自重试又各开一个 sidecar ——
// 实测一次失败放大成整分钟 95 次 spawn。
function retire() {
  const current = active;
  active = null;
  if (!current) return;
  if (current.inflight > 0) {
    current.retired = true;
    setTimeout(() => killChild(current), RETIRE_MAX_MS).unref?.();
    return;
  }
  killChild(current);
}

function start() {
  if (starting) return starting;
  retryAt = 0;
  // stop() 可能在 spawn 等待期间发生：此时这个 promise 已被作废，settle 后
  // 再写入 active 会把旧 sidecar 复活，下次 stop() 就杀不到它（进程泄漏）。
  const gen = startGen;
  console.log(`[OpenCodeTransport] starting sidecar: ${OPENCODE_TRANSPORT_CONFIG.bunBin} ${sidecarPath()}`);
  starting = new Promise((resolve, reject) => {
    const token = randomBytes(24).toString("hex");
    // 父进程已经决定这条请求走哪条出口（payload.proxy 为 null 即直连）。
    // 若把 HTTP(S)_PROXY 继承给 Bun，sidecar 会在 proxy:null 时回退到 env 代理，
    // 把父进程判定的 direct 请求重新推进公共出口池——私有地址绕行在真正发请求的
    // 进程里失效。sidecar 内的出口只允许由 payload.proxy 决定。
    const childEnv = { ...process.env, OPENCODE_TRANSPORT_TOKEN: token, OPENCODE_TRANSPORT_PORT: "0" };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      delete childEnv[name];
    }
    const child = spawn(OPENCODE_TRANSPORT_CONFIG.bunBin, [sidecarPath()], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("sidecar did not report ready")), OPENCODE_TRANSPORT_CONFIG.readyTimeoutMs);

    function finish(error, port) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        starting = null;
        try { child.kill("SIGKILL"); } catch { }
        block(error);
        reject(error);
        return;
      }
      if (gen !== startGen) {
        try { child.kill("SIGKILL"); } catch { }
        reject(new Error("superseded"));
        return;
      }
      active = { child, port, token, inflight: 0, retired: false };
      starting = null;
      resolve(active);
    }

    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY (\d+)/);
      if (match) finish(null, Number(match[1]));
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on("error", (error) => finish(new Error(`spawn failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`sidecar exited (${code ?? signal}) ${stderr}`.trim()));
      else if (active?.child === child) active = null;
    });
  });
  return starting;
}

async function ensure() {
  if (!available()) return null;
  if (active) return active;
  try {
    return await start();
  } catch {
    return null;
  }
}

function headerObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function" && !Array.isArray(headers)) {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

function forward(transport, payload, signal, headerTimeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let headerTimer = null;
    // 在途计数覆盖到响应体结束，不只是响应头：SSE 的 body 流还在跑的时候
    // 退役 sidecar 照样会掐断它。
    let settled = false;
    transport.inflight++;
    const done = () => {
      if (settled) return;
      settled = true;
      transport.inflight--;
      if (transport.retired && transport.inflight === 0) killChild(transport);
    };
    let request;
    try {
      request = http.request({
        host: "127.0.0.1",
        port: transport.port,
        path: TRANSPORT_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-transport-token": transport.token,
        },
      }, (response) => {
        if (headerTimer) clearTimeout(headerTimer);
        response.on("close", done);
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
          else if (value != null) headers.set(key, value);
        }
        resolve(new Response(Readable.toWeb(response), {
          status: response.statusCode || 502,
          statusText: response.statusMessage || "",
          headers,
        }));
      });
    } catch (error) {
      // http.request 同步抛错（header 非法、fd 耗尽）时不会有 error 事件，
      // 不在这里归还计数会让 retire() 等到 30s 兜底才回收进程。
      done();
      reject(error);
      return;
    }
    request.on("error", (error) => {
      if (headerTimer) clearTimeout(headerTimer);
      done();
      reject(error);
    });
    if (headerTimeoutMs > 0) {
      headerTimer = setTimeout(() => {
        const timeout = new Error(`upstream header timeout (${headerTimeoutMs}ms)`);
        timeout.transportTimeout = true;
        request.destroy(timeout);
      }, headerTimeoutMs);
      headerTimer.unref?.();
    }
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
    }
    request.end(body);
  });
}

export async function fetchViaTransport(url, options = {}, proxyOptions = null) {
  if (!available()) return null;
  if (normalizeString(proxyOptions?.vercelRelayUrl)) return null;
  if (typeof options.body !== "string" || !options.body) return null;

  const target = typeof url === "string" ? url : url.toString();
  const { url: proxyUrl } = resolveEffectiveProxyUrl(target, proxyOptions);
  const streamBody = typeof options.body === "string" && /"stream"\s*:\s*true/.test(options.body);
  const headerTimeoutMs = streamBody ? OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs : 0;

  // A sidecar whose upstream fetch failed may hold a stale pooled socket or a
  // proxy that just reset. Restarting Bun is cheap and clears both; retry the
  // same payload once before declaring the transport unavailable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = await ensure();
    if (!transport) return null;

    try {
      const response = await forward(transport, {
        url: target,
        method: options.method || "POST",
        headers: headerObject(options.headers),
        body: options.body,
        proxy: proxyUrl || null,
        // 0 = 不设上限（非流式：长生成可能在响应头返回前就超过 19s）
        timeoutMs: headerTimeoutMs,
      }, options.signal, headerTimeoutMs);
      if (response.headers.get("x-transport-error") === "1") {
        const detail = await response.text().catch(() => "");
        // sidecar 自己在 19s 处中止并回 504（timeout:true）：语义等同
        // forward 的 headerTimeout，必须走同一套 30s 冷却。否则每条撞上死
        // 出口的请求都会 retire 一次 sidecar，退化成 spawn 风暴。
        let upstreamTimeout = false;
        try { upstreamTimeout = JSON.parse(detail)?.timeout === true; } catch { }
        console.warn(
          `[OpenCodeTransport] upstream fetch failed (attempt ${attempt + 1}/2)${upstreamTimeout ? " [timeout]" : ""}: ${detail.slice(0, 300)}`
        );
        if (upstreamTimeout) {
          // 同一出口（同一 proxyUrl）重试必然再等满一次超时：attempt 1 只是把
          // 20s 变成 40s。这里只负责清掉可能僵死的池化 socket，请求本身直接
          // 交回上层换出口；30s 冷却避免大批量超时时把 sidecar 反复杀穿。
          if (Date.now() - lastResetAt >= 30000) {
            lastResetAt = Date.now();
            console.warn("[OpenCodeTransport] sidecar reported upstream timeout; restarting sidecar to drop stale socket");
            retire();
          } else {
            console.warn("[OpenCodeTransport] sidecar reported upstream timeout; reset throttled, fail fast");
          }
          return null;
        }
        // sidecar 报的是上游 fetch 失败（非超时）。非流式没有 cleanup 需求，
        // 重试同一出口只会重复失败；只在 30s 冷却外重启一次以清池。
        if (Date.now() - lastResetAt >= 30000) {
          lastResetAt = Date.now();
          retire();
        }
        return null;
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError") return null;
      // 响应头超时 = 出口路径死了（sidecar 本身活着）。不重启 sidecar 再试一次
      // （同一代理必然再挂），直接交给上层换另一条出口，把 60s 白等压到 20s。
      if (error.transportTimeout) {
        // 超时的常见成因是 Bun 的池化 socket 已死（隧道静默断开、本地仍 ESTAB），
        // 同一 sidecar 会一直复用它 → 后续每条请求都白等满超时。重启 sidecar 才
        // 能清池；30s 冷却避免大批量超时时把 sidecar 反复杀穿。
        if (Date.now() - lastResetAt >= 30000) {
          lastResetAt = Date.now();
          console.warn(`[OpenCodeTransport] ${error.message}; restarting sidecar to drop stale socket`);
          retire();
        } else {
          console.warn(`[OpenCodeTransport] ${error.message}; sidecar reset throttled, fail fast`);
        }
        return null;
      }
      console.warn(`[OpenCodeTransport] forward failed (attempt ${attempt + 1}/2): ${error.message}`);
      // socket hang up 多半是别的请求刚把共享 sidecar 退役了，不是本请求的
      // 上游有问题。此时重试会再开一个 sidecar，把一次失败放大成雪崩。
      if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        if (attempt === 0) continue;
        return null;
      }
      if (attempt === 0) {
        retire();
        continue;
      }
      return null;
    }
  }
  return null;
}

const EXIT_HOOK = Symbol.for("ninerouter.opencodeTransport.exitHook");
if (!globalThis[EXIT_HOOK]) {
  globalThis[EXIT_HOOK] = true;
  // 只挂 exit：SIGINT/SIGTERM 上主动 process.exit(0) 会与 db 层同期注册的
  // 冲洗处理器竞争（先注册先执行），把 WAL 里未落盘的请求详情一起带走。
  // 信号路径交给 db/gateway 自己收尾，sidecar 由 ppid 看门狗 2s 内自退。
  process.once("exit", stop);
}

export function resetTransport() {
  stop();
  retryAt = 0;
}
