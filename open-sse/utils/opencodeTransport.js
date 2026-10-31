import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { OPENCODE_TRANSPORT_CONFIG } from "../config/runtimeConfig.js";
import { assertEgressTargetAllowed, normalizeString, resolveEffectiveProxyUrl } from "./proxyResolution.js";

const TRANSPORT_PATH = "/forward";
const SIDECAR = path.join("scripts", "opencode-transport.mjs");
// 退役的 sidecar 最多再活这么久：在途请求若挂住不结束，兜底回收进程。
const RETIRE_MAX_MS = 30000;

let active = null;
let starting = null;
let retryAt = 0;
let startGen = 0;
let lastResetAt = 0;

// 上一次请求具体栽在哪一步。executor 的合成 503 文案直接读它：以前所有失败都
// 报同一句 "sidecar unavailable"，把 60s 连接超时、上游无首字节、socks 出口、
// sidecar 启动失败全说成一件事，只能靠时间戳反推。只记录、不改变控制流。
let lastFailure = null;
function noteFailure(reason) {
  lastFailure = reason;
  return null;
}

// sidecar 按 (proxy, generation) 分桶复用 socket：换线后 bump 一次，
// 下一次请求就会拿到新 session / 新连接，而不是骑在旧隧道上。
let transportGeneration = 0;
export function bumpTransportGeneration() {
  transportGeneration += 1;
  return transportGeneration;
}

export function peekTransportFailure() {
  return lastFailure;
}

function available() {
  return OPENCODE_TRANSPORT_CONFIG.mode !== "off" && Date.now() >= retryAt;
}

function sidecarPath() {
  return normalizeString(process.env.OPENCODE_TRANSPORT_SCRIPT) || path.join(process.cwd(), SIDECAR);
}

function block(error) {
  retryAt = Date.now() + OPENCODE_TRANSPORT_CONFIG.failureBackoffMs;
  // 这里是模块级 spawn 失败的兜底（没有请求上下文，拿不到 log）：
  // 调用方拿到 synthetic 503 时会用带 tag 的 warnTransport 再报一次。
  console.warn("[OpenCodeTransport] " + error.message);
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
  console.log("[OpenCodeTransport] " + `starting sidecar: ${OPENCODE_TRANSPORT_CONFIG.bunBin} ${sidecarPath()}`);
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

// log 由执行器递进来（可为空）：传输层失败也要能按会话/tag/req= 归档，
// 之前这里全是裸 console.warn，线上只能看到时间戳（审查发现）。
function transportWarn(log, message) {
  if (log && typeof log.warn === "function") log.warn("TRANSPORT", message);
  else console.warn("[OpenCodeTransport] " + message);
}

export async function fetchViaTransport(url, options = {}, proxyOptions = null, log = null) {
  // 闸在 available() 之前：能不能发请求是配置问题，许不许发给这个目标不是。
  // 只装在 proxyFetch 里等于没装 —— auto 模式下 executor 先问 sidecar。
  await assertEgressTargetAllowed(typeof url === "string" ? url : url.toString());
  if (!available()) return noteFailure(OPENCODE_TRANSPORT_CONFIG.mode === "off" ? "mode-off" : "sidecar-backoff");
  if (normalizeString(proxyOptions?.vercelRelayUrl)) return noteFailure("vercel-relay");
  if (typeof options.body !== "string" || !options.body) return noteFailure("body-not-string");

  const target = typeof url === "string" ? url : url.toString();
  const { url: proxyUrl } = resolveEffectiveProxyUrl(target, proxyOptions);
  // Bun 1.4.4 的 FetchSession 只接受 http(s) 代理：给 socks5:// 会抛
  // TypeError UnsupportedProxyProtocol（2026-10-28 实测，http 目标会被当成
  // 直连所以旧测试没暴露）。这里返回 null 让调用方给出"配置不支持"的明确
  // 结果，而不是让它进 attempt 循环把 19s 超时重放两遍。
  if (proxyUrl && !/^https?:\/\//i.test(proxyUrl)) return noteFailure(`unsupported-proxy:${proxyUrl.split(":")[0]}`);
  const streamBody = typeof options.body === "string" && /"stream"\s*:\s*true/.test(options.body);
  const headerTimeoutMs = streamBody ? OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs : 0;

  // A sidecar whose upstream fetch failed may hold a stale pooled socket or a
  // proxy that just reset. Restarting Bun is cheap and clears both; retry the
  // same payload once before declaring the transport unavailable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = await ensure();
    if (!transport) return noteFailure(available() ? "sidecar-start-failed" : "sidecar-backoff");

    try {
      const response = await forward(transport, {
        url: target,
        method: options.method || "POST",
        headers: headerObject(options.headers),
        body: options.body,
        proxy: proxyUrl || null,
        sessionGeneration: transportGeneration,
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
        transportWarn(log, 
          `upstream fetch failed (attempt ${attempt + 1}/2)${upstreamTimeout ? " [timeout]" : ""}: ${detail.slice(0, 300)}`
        );
        if (upstreamTimeout) {
          // 同一出口（同一 proxyUrl）重试必然再等满一次超时：attempt 1 只是把
          // 20s 变成 40s。这里只负责清掉可能僵死的池化 socket，请求本身直接
          // 交回上层换出口；30s 冷却避免大批量超时时把 sidecar 反复杀穿。
          if (Date.now() - lastResetAt >= 30000) {
            lastResetAt = Date.now();
            transportWarn(log, "sidecar reported upstream timeout; restarting sidecar to drop stale socket");
            retire();
          } else {
            transportWarn(log, "sidecar reported upstream timeout; reset throttled, fail fast");
          }
          return noteFailure("upstream-timeout");
        }
        // sidecar 报的是上游 fetch 失败（非超时）。非流式没有 cleanup 需求，
        // 重试同一出口只会重复失败；只在 30s 冷却外重启一次以清池。
        if (Date.now() - lastResetAt >= 30000) {
          lastResetAt = Date.now();
          retire();
        }
        return noteFailure("upstream-fetch-failed");
      }
      return response;
    } catch (error) {
      // 调用方放弃 = base.execute 的 60s connect timeout，或客户端自己断开。
      // 这条路上 sidecar 里一定还挂着那条不回头的 socket：以前这里直接 return null，
      // 于是 a) executor 把「60s 没拿到响应头」说成 "sidecar unavailable"，
      // b) 池子没人清，下一个请求继续复用死 socket，要等 Bun 的 idleTimeout 才自愈
      // （实测一整段 2 分钟的同形态 503）。retire 掉，让下一条请求从干净进程开始。
      // 冷却复用下面 transportTimeout 的 30s 节流，避免每个超时都 spawn 一次。
      if (options.signal?.aborted || error.name === "AbortError") {
        if (Date.now() - lastResetAt >= 30000) {
          lastResetAt = Date.now();
          transportWarn(log, "caller aborted before headers; retiring sidecar to drop stale socket");
          retire();
        }
        return noteFailure(options.signal?.aborted ? "caller-aborted" : "abort-error");
      }
      // 响应头超时 = 出口路径死了（sidecar 本身活着）。不重启 sidecar 再试一次
      // （同一代理必然再挂），直接交给上层换另一条出口，把 60s 白等压到 20s。
      if (error.transportTimeout) {
        // 超时的常见成因是 Bun 的池化 socket 已死（隧道静默断开、本地仍 ESTAB），
        // 同一 sidecar 会一直复用它 → 后续每条请求都白等满超时。重启 sidecar 才
        // 能清池；30s 冷却避免大批量超时时把 sidecar 反复杀穿。
        if (Date.now() - lastResetAt >= 30000) {
          lastResetAt = Date.now();
          transportWarn(log, `${error.message}; restarting sidecar to drop stale socket`);
          retire();
        } else {
          transportWarn(log, `${error.message}; sidecar reset throttled, fail fast`);
        }
        return noteFailure("header-timeout");
      }
      transportWarn(log, `forward failed (attempt ${attempt + 1}/2): ${error.message}`);
      // socket hang up 多半是别的请求刚把共享 sidecar 退役了，不是本请求的
      // 上游有问题。此时重试会再开一个 sidecar，把一次失败放大成雪崩。
      if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        if (attempt === 0) continue;
        return noteFailure(`sidecar-socket-reset:${error.code}`);
      }
      if (attempt === 0) {
        retire();
        continue;
      }
      return noteFailure(`forward-failed:${error.message}`);
    }
  }
  return noteFailure("transport-exhausted");
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
