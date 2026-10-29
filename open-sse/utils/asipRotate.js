import http from "node:http";
import fs from "node:fs";

/**
 * asip 同步轮换客户端。
 *
 * 走 Unix domain socket 而不是 TCP：WSL 镜像网络下 127.0.0.1 与 Windows 宿主共享，
 * 开端口等于把「换出口」这个动作暴露给宿主上任意进程。UDS 由 0600 文件权限保护。
 */

const SOCKET_PATH =
  process.env.ASIP_SOCKET || "/home/administrator/auto-swicth-ip/run/rotate.sock";
const TOKEN_PATH =
  process.env.ASIP_TOKEN_FILE || "/home/administrator/auto-swicth-ip/run/api-token";
// 2000ms，不是随手取的上限：实测 10 次换线 min 774 / p50 1090 / p90 1314 /
// max 1374 ms（16 条 WG 线 + 3 条 usque，探测器同时在跑）。800ms 会砍掉一半
// 正常换线，1500ms 对 1374 的尾巴只剩 9% 余量。超时还有额外代价：请求被销毁，
// 但 asip 那边的换线不会停，于是客户端在旧隧道上重试、出口却已经换了。
// 宁可多等一次，也不要这种「换了但没等」的错位。
const TIMEOUT_MS = Number(process.env.ASIP_TIMEOUT_MS || 2000);

// 关掉之后连本地都不连，一律当「这次没换」。存在的理由很具体：跑全量测试时会
// 走到 429 分支，asip 的 /rotate 是真的切生产 sing-box 选择器 —— 一次测试就把
// 线上出口换掉，而且结果取决于当时网络。测试里由 tests/setup.js 置 1。
const DISABLED = process.env.ASIP_DISABLED === "1";

// 调用方据此决定「要不要为一次可能的重试先克隆 body」：asip 关着时克隆纯属浪费。
export function asipRotationEnabled() {
  return !DISABLED;
}

let lastToken = null;

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (token) lastToken = token;
    return token;
  } catch {
    // 文件被轮换的瞬间可能读不到：退回上次读到的，总比直接放弃好。
    return lastToken;
  }
}

function callAsip(path, payload, signal = null) {
  return new Promise((resolve) => {
    if (DISABLED) return resolve({ error: "disabled" });
    const token = readToken();
    if (!token) return resolve({ error: "no-token" });
    const body = payload ? JSON.stringify(payload) : "";
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path,
        method: payload ? "POST" : "GET",
        timeout: TIMEOUT_MS,
        headers: {
          "X-Asip-Token": token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({ error: "timeout" });
          }
        });
      }
    );
    // 超时/连不上都当作「这次没换」：接口是增强，不能让它拖垮请求本身。
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve({ error: "socket" }));
    if (body) req.write(body);
      if (signal) signal.addEventListener("abort", () => req.destroy(), { once: true });
    req.end();
  });
}

/**
 * 请求 asip 换一次出口。
 *
 * 返回值里 switched 只说「这一次调用是否真的换了线」，不能用来判断该不该重试 ——
 * 并发时 asip 会把重复请求合并（reason=coalesced, switched=false），但那次合并
 * 之前确实有人换过线，本次请求照样值得重试。所以判断一律用 switchedAt 与请求
 * 发起时刻比较：只要换线发生在请求发出之后，旧连接上的 429 就和新隧道无关。
 */
export async function rotateEgress(reason = "rate429", { signal = null } = {}) {
  // 客户端已经断开时不必再换线：换了服务的是别人，白烧一次出口。
  if (signal?.aborted) return { switched: false, switchedAt: 0, reason: "aborted" };
  const res = await callAsip("/rotate", { reason }, signal);
  // 超时和「asip 没在跑」是两回事：超时说明换线很可能已经发生、只是没等到回话，
  // 调用方要据此提前重建连接（审查发现）。
  if (res && res.error) return { switched: false, switchedAt: 0, reason: res.error };
  if (!res) return { switched: false, switchedAt: 0, reason: "unavailable" };
  return {
    switched: Boolean(res.switched),
    switchedAt: Math.round(Number(res.switched_at || 0) * 1000),
    reason: res.reason || (res.switched ? "ok" : "unknown"),
  };
}

