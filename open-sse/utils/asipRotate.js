import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalProxyKey } from "./proxyResolution.js";
import { getWritableDataDir } from "./writableDataDir.js";

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

// 无健康备槽时由本进程重启：asip 那边六条闸都在后台修，没有端口能立刻接管
// 这条请求。主链路不再同步探线/换线兜底；这里重建连接池、清掉进程内冷却表，
// 等闸修好重新来。必须用非 0 退出码：systemd 是 Restart=on-failure，
// /api/shutdown 的 process.exit(0) 会让服务停住不拉起（且 production 下那个
// 端点直接 403，本来就调不通）。
const SELF_RESTART_GAP_MS = Number(
  process.env.ASIP_SELF_RESTART_GAP_MS || 60_000);
const SELF_RESTART_DELAY_MS = 1000;
let lastSelfRestartAt = 0;

function selfRestartIsDryRun() {
  // 测试里绝不能真的把 worker 退掉；helper 仍返回"本会重启"供断言节流。
  return process.env.VITEST === "true"
    || Boolean(process.env.VITEST_WORKER_ID)
    || Boolean(process.env.VITEST_POOL_ID)
    || process.env.NODE_ENV === "test"
    || process.env.ASIP_SELF_RESTART_DISABLED === "1";
}

// 节流时间戳必须落盘：lastSelfRestartAt 是进程内内存态，process.exit(1)
// 之后归零，新进程一启动就又能重启一次。线上 19:52:25 / 19:52:39 两次
// 自重启正是这样连着发生的（9router 进程启动计数 3）。
// 测试环境一律写 tmpdir，绝不碰生产数据目录。
function selfRestartStateFile() {
  if (process.env.ASIP_SELF_RESTART_STATE_FILE) {
    return process.env.ASIP_SELF_RESTART_STATE_FILE;
  }
  const base = selfRestartIsDryRun()
    ? path.join(os.tmpdir(), "9router-vitest")
    : getWritableDataDir();
  return path.join(base, "runtime", "asip-self-restart.json");
}

function readPersistedSelfRestartAt() {
  try {
    const raw = JSON.parse(fs.readFileSync(selfRestartStateFile(), "utf8"));
    const at = Number(raw && raw.at);
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0; // 文件不存在 / 损坏：当作从未重启过，不阻塞必要的自重启。
  }
}

function persistSelfRestartAt(at) {
  try {
    const file = selfRestartStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at }), { mode: 0o600 });
  } catch (err) {
    // 写失败不能挡住自重启本身，但节流会退回进程内内存态，必须留下痕迹。
    console.warn("[ASIP] self-restart throttle state not persisted: " +
      (err && err.message ? err.message : err));
  }
}

export function requestAsipSelfRestart(now = Date.now()) {
  // 429 风暴里同一批请求都会拿到"无健康备槽"，不节流会反复重启到服务不可用。
  // 内存态兜底同一进程内的连发，落盘态兜住「重启后内存归零」。
  const last = Math.max(lastSelfRestartAt, readPersistedSelfRestartAt());
  if (now - last < SELF_RESTART_GAP_MS) return false;
  lastSelfRestartAt = now;
  // 必须在 setTimeout(exit) 之前同步写完，否则进程退出时状态可能还没落盘。
  persistSelfRestartAt(now);
  console.warn(
    "[ASIP] no healthy slot -> self-restart in " + SELF_RESTART_DELAY_MS +
    "ms (gates are repaired in background)"
  );
  if (!selfRestartIsDryRun()) {
    const timer = setTimeout(() => process.exit(1), SELF_RESTART_DELAY_MS);
    timer.unref?.();
  }
  return true;
}

export function resetAsipSelfRestartForTest() {
  lastSelfRestartAt = 0;
  try {
    fs.unlinkSync(selfRestartStateFile());
  } catch {
    // 文件本来就不存在。
  }
}

// 只清内存、保留落盘 —— 让单测能模拟「process.exit(1) 之后的新进程」。
export function resetAsipSelfRestartMemoryForTest() {
  lastSelfRestartAt = 0;
}

// 槽位端口健康冷却：asip 报某个端口 429/transport 后，新请求在短窗口内跳过
// 它；当前请求的 switchToUrl 即时重试不受影响。按规范化代理 URL 而不是 poolId
// 记录，同一端口即使被多个池/连接引用也一起避开。只存内存，重启即清。
const PROXY_COOLDOWN_DEFAULT_MS = Number(
  process.env.ASIP_PROXY_COOLDOWN_MS || 15_000);
const PROXY_COOLDOWN_MAX_MS = 60_000;
const proxyCooldowns = new Map(); // canonical proxy url -> until epoch ms

function proxyCooldownKey(proxyUrl) {
  const raw = String(proxyUrl || "").trim();
  if (!raw) return "";
  return canonicalProxyKey(raw) || raw;
}

export function markAsipProxyCooling(proxyUrl, untilMs = 0, ttlMs = 0) {
  const key = proxyCooldownKey(proxyUrl);
  if (!key) return 0;
  const now = Date.now();
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : PROXY_COOLDOWN_DEFAULT_MS;
  const wanted = Number(untilMs) > now
    ? Math.min(Number(untilMs), now + PROXY_COOLDOWN_MAX_MS)
    : now + Math.max(1000, Math.min(ttl, PROXY_COOLDOWN_MAX_MS));
  // 并发响应可能一个旧、一个新；只延长不缩短，避免迟到的旧回包提前放行坏端口。
  const until = Math.max(proxyCooldowns.get(key) || 0, wanted);
  proxyCooldowns.set(key, until);
  return until;
}

export function isAsipProxyCooling(proxyUrl, now = Date.now()) {
  const key = proxyCooldownKey(proxyUrl);
  if (!key) return false;
  const until = proxyCooldowns.get(key) || 0;
  if (until <= now) {
    proxyCooldowns.delete(key);
    return false;
  }
  return true;
}

export function clearAsipProxyCooling(proxyUrl) {
  const key = proxyCooldownKey(proxyUrl);
  if (key) proxyCooldowns.delete(key);
}

function applyProxyCooldownFromResponse(proxyUrl, res) {
  if (!proxyUrl || !res) return;
  const untilSec = Number(res.avoid_port_until);
  if (Number.isFinite(untilSec) && untilSec > 0) {
    markAsipProxyCooling(proxyUrl, untilSec * 1000);
  }
  // line_ok 是 asip 实测同一出口仍可用的明确结论：把它从短冷却里提前放出，
  // 否则一个本来健康的端口会被无谓跳过 15 秒。
  if (res.reason === "line_ok") clearAsipProxyCooling(proxyUrl);
}

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
    let req;
    try {
      req = http.request(
        {
          socketPath: SOCKET_PATH,
          path,
          method: payload ? "POST" : "GET",
          timeout: TIMEOUT_MS,
          // 不复用连接。Node 的全局 agent 默认 keepAlive，第一次 /rotate 的连接会
          // 进池；asip 重启或服务端关掉它之后，下一次请求拿到的是一条已死的 socket
          // → 直接报 socket，等于这次换线白问。换线本来就是低频动作（实测 468 次/
          // 进程生命周期），每次新开一条 UDS 的代价可以忽略。
          agent: false,
          headers: {
            "X-Asip-Token": token,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          // asip 换线途中被 systemd 重启 / OOM 时，响应会半截断掉：
          // res 只发 aborted + error，req 只发 close，end 永远不来。
          // 之前这里只挂 data/end，Promise 就永久 pending —— 而两处 await 外层
          // 没有超时，请求直接挂死（审查发现，实测 3s 仍未 settle）。
          res.on("aborted", () => resolve({ error: "bad-response" }));
          res.on("error", () => resolve({ error: "socket" }));
          if (res.statusCode >= 400) {
            res.resume();
            resolve({ error: "bad-status-" + res.statusCode });
            return;
          }
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(buf));
            } catch {
              resolve({ error: "bad-response" });
            }
          });
        }
      );
    } catch {
      // http.request 自身会同步抛（header 里有非法字符，比如 token 文件写坏、
      // 带进了控制字符）。这里若让它 reject，异常会穿出 execute()，
      // 用户请求变成 500 —— 而这个客户端的原则是「失败只降级，不拖垮请求」。
      return resolve({ error: "socket" });
    }
    // 超时/连不上都当作「这次没换」：接口是增强，不能让它拖垮请求本身。
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    // 客户端自己走了（abort）和 asip 连不上是两回事：前者不该触发重试。
    req.on("error", () => resolve({ error: signal?.aborted ? "aborted" : "socket" }));
    // 兜底：任何让上面几条路径都没走到的收尾，都不许让 await 挂着。
    req.on("close", () => resolve({ error: "socket" }));
    if (body) req.write(body);
    // 头已到、body 没写完时 abort：req 不会发 error，只有 close —— 所以这里直接
    // resolve，别指望下面的兜底去猜（审查发现，实测 12s 仍未 settle）。
    if (signal) signal.addEventListener("abort", () => {
      req.destroy();
      resolve({ error: "aborted" });
    }, { once: true });
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
 *
 * `failedEgress` 是这条 429 打通的那个出口地址（请求发出时从
 * currentAsipEgress() 取）。asip 拿它对照自己的换线表：若这个地址是在本条请求
 * **发出之后**被换掉的，说明请求骑的是一条已下线的隧道，回 already_retired ——
 * 重连即可，不必再烧一条新线。
 *
 * 地址必须由 asip 给，客户端探不了：proxy 模式下 identifyFixedEgress 对
 * proxy/relay 一律返回 ip:null，只有 direct 才探测，而 direct 探到的是本机
 * 直连地址，与经 sing-box 的代理链路没有关系。
 */
export async function rotateEgress(
  reason = "rate429",
  { signal = null, requestStartedAt = 0, failedEgress = null, failedEgressSince = null, proxyUrl = null, reqId = null, retryAfterMs = 0 } = {},
) {
  // 客户端已经断开时不必再换线：换了服务的是别人，白烧一次出口。
  if (signal?.aborted) return { switched: false, switchedAt: 0, reason: "aborted", lineChanged: false };
  // 先冷却坏端口，再等 asip 回话。asip 超时/不可达时本地也要能避开它；
  // 当前调用随后会用 switchToUrl 显式改走健康端口，不受这个过滤影响。
  if (proxyUrl && ["rate429", "abuse403", "transport"].includes(reason)) {
    markAsipProxyCooling(proxyUrl);
  }
  // requestStartedAt 让 asip 把坏账记到**发出这条请求时**的那条线。
  // 429 迟到几十秒，期间出口可能已经换过，此刻的活动线没承载过它。
  // failedEgress 让 asip 判断这条 429 追的地址是不是已经被换走了。
  // failedEgressSince 是那个地址的接入时刻：asip 用它判断客户端的缓存值在
  // 请求发出时是否已经就位 —— 只有就位过的地址，「已换走」才是可下的结论。
  const res = await callAsip("/rotate", {
    reason,
    ...(retryAfterMs > 0 ? { retry_after_ms: Math.round(retryAfterMs) } : {}),
    ...(requestStartedAt > 0 ? { request_started_at: requestStartedAt / 1000 } : {}),
    ...(failedEgress ? { egress_ip: failedEgress } : {}),
    ...(failedEgressSince > 0 ? { egress_since: failedEgressSince } : {}),
    ...(proxyUrl ? { egress_proxy_url: proxyUrl } : {}),
    ...(reqId ? { req_id: String(reqId) } : {}),
  }, signal);
  // 超时和「asip 没在跑」是两回事：超时说明换线很可能已经发生、只是没等到回话，
  // 调用方要据此提前重建连接（审查发现）。
  if (res && res.error) return { switched: false, switchedAt: 0, reason: res.error, lineChanged: false };
  if (!res) return { switched: false, switchedAt: 0, reason: "unavailable", lineChanged: false };
  applyProxyCooldownFromResponse(proxyUrl, res);
  // 排查通道：把请求 id、走的槽位端口、asip 结论写成一行。之前 /rotate 不带
  // reqId，两边日志只能靠时间戳对，无法把一条失败请求钉到具体闸口/出口上。
  if (reqId) {
    console.warn(
      "[ASIP] rotate req=" + reqId +
      " port=" + (proxyUrl || "-") +
      " reason=" + (res.reason || "?") +
      " switched=" + Boolean(res.switched) +
      " restart=" + Boolean(res.restart_required) +
      " line=" + (res.offending_tag || res.active_tag || "-") +
      " ip=" + (res.offending_egress || res.active_egress || "-") +
      " verdict=" + (res.offending_verdict || "n/a") +
      " to=" + (res.switch_to || "-") +
      " to_line=" + (res.switch_to_tag || "-") +
      " to_ip=" + (res.switch_to_egress || "-") +
      " to_url=" + (res.switch_to_url || "-")
    );
  }
  // 六条闸都在后台修、没有端口能立刻接管：主链路不再同步兜底，改由本进程
  // 重启重建连接池，等闸回来。统一放在这里触发，429 / transport / 连接超时
  // 三条调用路径都覆盖到，不必每个 executor 各写一遍。
  const restartRequired = Boolean(res.restart_required) && !res.switch_to_url;
  if (restartRequired) requestAsipSelfRestart();
  // asip 说「这次不知道出口是谁」（无健康备槽 / 并发抢锁）：不要碰本地记录。
  // 那一瞬间 selector 正在被另一次切换改写，读到的任何身份都是旧的；写进去
  // 就是用旧线覆盖真相，下一条 429 会带着错误出口去回溯。
  if (res.line_unknown) {
    return {
      switchToUrl: res.switch_to_url || null,
      switchToPool: res.switch_to || null,
      switchToEgress: res.switch_to_egress || null,
      switched: false,
      switchedAt: Math.round(Number(res.switched_at || 0) * 1000),
      // 要自重启时统一改口成 no_healthy_slot。旧版 asip 在无健康备槽时仍回
      // reason=ok/coalesced，opencode 的 429 早退分支会把它们当「换过线了，
      // 重连再试一次」—— 明明没有可用闸口，还要在刚烧掉的原端口上多打一发，
      // 而 1s 后本进程就退出了。在这里归一，三条 executor 调用路径一次覆盖。
      reason: restartRequired ? "no_healthy_slot" : (res.reason || "coalesced"),
      lineChanged: false,
      lineUnknown: true,
      restartRequired,
      avoidPortUntil: Number.isFinite(Number(res.avoid_port_until))
        ? Number(res.avoid_port_until) * 1000 : 0,
    };
  }
  // 接入时刻单独存：`noteActiveLine` 只在身份变化时才该改变 `lineChanged` 的
  // 判定，而 since 每次都要跟新 —— 同一个地址可能被 asip 重新确认过多次。
  if (typeof res.active_egress_since === "number" && res.active_egress_since > 0) {
    lastEgressSince = res.active_egress_since;
  } else if (res.active_egress) {
    // asip 说这个地址还在，但给不出接入时刻（早于它的记录窗口）。留 null 而不是
    // 沿用上一个地址的时刻：那个时刻属于另一个地址，拿来判断只会得到错误结论。
    lastEgressSince = null;
  }
  return {
    // 多端口：asip 让这次重试改走另一台 sing-box 的端口。独立进程、独立连接
    // 池，命中即可用，不需要等它换线。
    switchToUrl: res.switch_to_url || null,
    switchToPool: res.switch_to || null,
    switchToEgress: res.switch_to_egress || null,
    switched: Boolean(res.switched),
    switchedAt: Math.round(Number(res.switched_at || 0) * 1000),
    reason: res.reason || (res.switched ? "ok" : "unknown"),
    lineChanged: noteActiveLine(res.active_tag, res.active_egress),
    restartRequired,
    avoidPortUntil: Number.isFinite(Number(res.avoid_port_until))
      ? Number(res.avoid_port_until) * 1000 : 0,
  };
}

// 上一次见到的出口身份。换线是异步的：asip 换完之后，本进程还在旧连接上发请求，
// 那些请求的结果被 asip 当成「新出口不好」的证据，于是好线被切走。
//
// 身份是「线名 + 出口地址」两项，不是一个。只比线名会漏掉原地重连 ——
// asip 重启当前隧道换会话地址时 selector 不动、线名不变，但连接全断过、
// 地址也换了。那种换法必须也算「变了」。
//
// 只在 /rotate 时比对，不在每个请求前比对：/rotate 是唯一与换线相关的时机，
// 而正常的 429/503 路径在拿到回复后本来就会重建连接。多问一次的成本是发给
// 本机 socket 的一个小 JSON，收益是能看见「没有人通知过我们」的那类换线。
let lastSeenLine = null;

// 出口地址 + 它是什么时候接上的（asip 给的 active_egress_since，epoch 秒）。
// 只缓存地址不够：`已经切走` 与 `切走之前发出的 429` 是两件相反的事，而单看
// 地址分不出来。带上接入时刻，调用方才能回答「我这条请求发出时，这个地址是否
// 已经就位」。
let lastEgressSince = null;

/** 本进程最近一次从 asip 那里看到的出口地址。 */
export function currentAsipEgress() {
  return lastSeenLine ? lastSeenLine.split("|")[1] || null : null;
}

/** 那个地址是什么时候接上的（epoch 秒）；未知时为 null。 */
export function currentAsipEgressSince() {
  return lastEgressSince;
}

/** 记下这次看到的出口身份；返回「和上次不同」。 */
export function noteActiveLine(tag, egress) {
  // 两个都是空值也照样算一次观测：落池到 proxy 时 asip 就是回两个 null，
  // 而「从某条线变成不是任何线」正是必须重置连接的那一次。只有「从没观测过」
  // 才不构成变化 —— 进程刚起，没有可比的基准。
  const seen = String(tag || "") + "|" + String(egress || "");
  const changed = lastSeenLine !== null && lastSeenLine !== seen;
  lastSeenLine = seen;
  return changed;
}

/** 忘掉见过的身份（测试隔离用；进程里不需要）。 */
export function forgetActiveLine() {
  lastSeenLine = null;
  lastEgressSince = null;
}

