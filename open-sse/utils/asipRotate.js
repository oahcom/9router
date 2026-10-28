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
const TIMEOUT_MS = Number(process.env.ASIP_TIMEOUT_MS || 1500);

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

function callAsip(path, payload) {
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) return resolve(null);
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
            resolve(null);
          }
        });
      }
    );
    // 超时/连不上都当作「这次没换」：接口是增强，不能让它拖垮请求本身。
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    if (body) req.write(body);
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
export async function rotateEgress(reason = "rate429") {
  const res = await callAsip("/rotate", { reason });
  if (!res) return { switched: false, switchedAt: 0, reason: "unavailable" };
  return {
    switched: Boolean(res.switched),
    switchedAt: Math.round(Number(res.switched_at || 0) * 1000),
    reason: res.reason || (res.switched ? "ok" : "unknown"),
  };
}

export async function readAsipState() {
  return callAsip("/debug/state", null);
}