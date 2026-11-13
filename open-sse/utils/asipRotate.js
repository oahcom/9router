import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalProxyKey } from "./proxyResolution.js";
import { getWritableDataDir } from "./writableDataDir.js";
import { currentReqId } from "./requestContext.js";
import { bumpEgressGeneration } from "./egressGeneration.js";

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
  { signal = null, requestStartedAt = 0, failedEgress = null, failedEgressSince = null, proxyUrl = null, reqId = null, retryAfterMs = 0, borrowed = false } = {},
) {
  // 调用方没带 reqId 时退回请求上下文：proxyFetch 那一层拿不到请求标识，
  // 它发起的 transport 换线在 asip 侧于是全是 req=-（实测 281 条），
  // 无法按请求串日志。这里统一兜底，三条调用路径一次覆盖。
  reqId = reqId || currentReqId();
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
    // 借道标记：这条 429 的请求不是本端口发起的。asip 据此只冷却、不判死。
    ...(borrowed ? { borrowed: true } : {}),
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
      (borrowed ? " borrowed=1" : "") +
      " switched=" + Boolean(res.switched) +
      " restart=" + Boolean(res.restart_required) +
      " line=" + (res.offending_tag || res.active_tag || "-") +
      " ip=" + (res.offending_egress || res.active_egress || "-") +
      " verdict=" + (res.offending_verdict || "n/a") +
      " to=" + (res.switch_to || "-") +
      " to_line=" + (res.switch_to_tag || "-") +
      " to_ip=" + (res.switch_to_egress || "-") +
      " to_node=" + (res.switch_to_node || "-") +
      " to_url=" + (res.switch_to_url || "-")
    );
  }
  // 六条闸都在后台修、没有端口能立刻接管。这里只重建「连接」，不动进程：
  // 作废该端口的 egress generation，后续请求用新 key 建新连接；同时清掉进程内
  // 冷却表，免得刚被 429 的端口在闸修好后仍被跳过。
  // 不重启进程的理由：槽位不健康是出口侧（WARP 线）的问题，重启进程不会让闸
  // 变健康，却要付 Next.js 冷启动数秒、切断全部在途请求、把压缩层一起拖下水
  // 的代价；而且 asip 后台修闸要时间，进程重启只会变成 60s 一次的自杀循环。
  const restartRequired = Boolean(res.restart_required) && !res.switch_to_url;
  if (restartRequired) {
    bumpEgressGeneration(proxyUrl, { force: true });
    proxyCooldowns.clear();
  }
  // asip 说「这次不知道出口是谁」（无健康备槽 / 并发抢锁）：不要碰本地记录。
  // 那一瞬间 selector 正在被另一次切换改写，读到的任何身份都是旧的；写进去
  // 就是用旧线覆盖真相，下一条 429 会带着错误出口去回溯。
  if (res.line_unknown) {
    return {
      switchToUrl: res.switch_to_url || null,
      switchToPool: res.switch_to || null,
      switchToEgress: res.switch_to_egress || null,
      // 第七闸口换的是池节点，没有 /128 出口地址；节点名单独透传，
      // 让调用方能证明「这台闸确实换了出口」而不必伪造一个 IP。
      switchToNode: res.switch_to_node || null,
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
  // 这台闸现在的出口身份记到端口名上（不是进程级全局）：下一次同端口的
  // 请求带着 failedEgress 回去时，才是它自己那条线的地址。
  notePortLine(proxyUrl, res.active_tag, res.active_egress,
               res.active_egress_since);
  return {
    // 多端口：asip 让这次重试改走另一台 sing-box 的端口。独立进程、独立连接
    // 池，命中即可用，不需要等它换线。
    switchToUrl: res.switch_to_url || null,
    switchToPool: res.switch_to || null,
    switchToEgress: res.switch_to_egress || null,
    // 第七闸口（代理池兜底）的池内换节点：节点 tag 是它唯一的出口身份。
    switchToNode: res.switch_to_node || null,
    // asip 眼里「这台闸现在挂着哪个出口地址」。没有 switch_to 时（already_retired
    // 的原地重连、line_ok）这是唯一能证明「地址确实换了」的字段：调用方拿它跟
    // 上一发打过的地址比，相同就说明这一发还是同一个 /128，重试没有意义。
    activeEgress: res.active_egress || null,
    activeTag: res.active_tag || null,
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

// ── 每端口一份出口身份 ──────────────────────────────────────────────────
// 上面 lastSeenLine 是**进程级**全局：任意并发请求的 /rotate 都会覆写它。
// 拿它当「这条请求骑的地址」是错的 —— 实测 277 条带报障地址的记录里，144 条
// 与本槽出口不在同一个 /64，就是被别的请求覆写的残留值。asip 拿这个错地址去
// 判 already_retired、去 avoid，惩罚的全是无辜的线。
//
// 端口是稳定键：9router 只知道 127.0.0.1:789N，而每台 sing-box 的 selector
// 才是「这台闸现在挂哪条线」。所以身份按端口存，来源有两条：
//   1. /rotate 的回包里 active_tag / active_egress（该端口权威值）；
//   2. /slots 快照（带 port 字段），用来填还没有过 rotate 记录的端口。
const PORT_LINES = new Map(); // "7896" -> { tag, egress, since, at }
let slotSnapshot = null; // { at, byPort: Map }
const SLOT_SNAPSHOT_TTL_MS = 5000;
// asip 会主动换线（proactive），端口上挂的地址随时可能变，而 /rotate 回包只在
// 出事时才来。缓存不放过期时间的话，一条几小时前记下的地址会被一直当成
// failedEgress 报回去 —— 这就又变回「全局旧值」了，只是按端口分了份。
const PORT_LINE_TTL_MS = Number(process.env.ASIP_PORT_LINE_TTL_MS || 30000);

function portOfProxyUrl(proxyUrl) {
  const m = /:(\d+)\/?$/.exec(String(proxyUrl || "").trim());
  return m ? m[1] : null;
}

/** 记下某个端口当前的出口身份（/rotate 回包里拿到的权威值）。 */
export function notePortLine(proxyUrl, tag, egress, since) {
  const port = portOfProxyUrl(proxyUrl);
  if (!port) return;
  const sinceNum = Number(since);
  PORT_LINES.set(port, {
    tag: tag || null,
    egress: egress || null,
    since: Number.isFinite(sinceNum) && sinceNum > 0 ? sinceNum : null,
    at: Date.now(),
  });
}

/** 只知道端口的同步查询；查不到就返回 null，调用方自行决定要不要问 asip。 */
export function egressForPort(proxyUrl) {
  const port = portOfProxyUrl(proxyUrl);
  if (!port) return { egress: null, since: null };
  const st = PORT_LINES.get(port);
  return { egress: st?.egress || null, since: st?.since ?? null };
}

/**
 * 问 asip 每台闸当前挂着哪个出口，灌进 PORT_LINES。
 *
 * 5 秒一次：/slots 要逐槽问 sing-box 的 clash API（6 次本地 HTTP），按请求
 * 打会把换线决策的成本摊到每一条流量上。慢 5 秒的代价只是「这一发自带地址
 * 可能旧一点」，asip 那边还有 requestStartedAt 兜底。
 */
export async function refreshSlotEgress({ signal = null } = {}) {
  const now = Date.now();
  if (slotSnapshot && now - slotSnapshot.at < SLOT_SNAPSHOT_TTL_MS) {
    return slotSnapshot.byPort;
  }
  const res = await callAsip("/slots", null, signal);
  if (!res || res.error || !Array.isArray(res.slots)) {
    return slotSnapshot?.byPort || null;
  }
  const byPort = new Map();
  for (const s of res.slots) {
    if (!s || s.port == null) continue;
    const port = String(s.port);
    byPort.set(port, { tag: s.tag || null, egress: s.egress || null, since: null });
    const cur = PORT_LINES.get(port);
    // rotate 回包带 since 且还新鲜时比快照权威，不覆盖；过期或地址对不上就
    // 必须以 /slots 为准，否则主动换线之后我们还在拿旧地址回溯。
    const fresh = cur?.at && now - cur.at < PORT_LINE_TTL_MS;
    const snapEgress = s.egress || null;
    if (!cur || !cur.egress || !fresh || cur.egress !== snapEgress) {
      // 订阅式感知（拉取侧）：asip 主动换线 / 探针重启隧道之后，/slots 里该
      // 端口挂的出口地址会变。这时立刻让该端口的池化连接失效，不必等下一条
      // 请求先撞死 20s。只认「旧地址确实存在且变了」，首次灌表不触发。
      // 注意这里只 bump generation，不动 PORT_LINES 之外的任何东西，也不会
      // 像每次请求都刷 /slots 那样把 failedEgressSince 冲掉。
      if (cur?.egress && cur.egress !== snapEgress) {
        bumpEgressGeneration(`http://127.0.0.1:${port}`, { force: true });
      }
      PORT_LINES.set(port, {
        tag: s.tag || null,
        egress: snapEgress,
        // 地址变了，旧 since 属于另一条线，不能沿用。
        since: cur && cur.egress === snapEgress ? (cur.since ?? null) : null,
        at: now,
      });
    }
  }
  slotSnapshot = { at: now, byPort };
  return byPort;
}

/** 这条请求走的端口现在挂着哪个出口。查不到时问一次 /slots。 */
export async function asipEgressForPort(proxyUrl, { signal = null } = {}) {
  const port = portOfProxyUrl(proxyUrl);
  if (!port) return { egress: null, since: null };
  const cached = PORT_LINES.get(port);
  const now = Date.now();
  if (cached?.egress && now - (cached.at || 0) < PORT_LINE_TTL_MS) {
    return { egress: cached.egress, since: cached.since ?? null };
  }
  await refreshSlotEgress({ signal });
  const after = PORT_LINES.get(port);
  // /slots 不可达时宁可报「未知」，也不要拿一份过期身份去判 already_retired。
  const refreshed = after?.at && Date.now() - after.at < PORT_LINE_TTL_MS;
  return {
    egress: refreshed ? (after.egress || null) : null,
    since: refreshed ? (after.since ?? null) : null,
  };
}

/** 仅测试用：清空端口身份表与 /slots 快照缓存，让用例之间互不污染。 */
export function resetPortLinesForTest() {
  PORT_LINES.clear();
  slotSnapshot = null;
}

/**
 * 本进程最近一次从 asip 那里看到的出口地址。
 *
 * @deprecated 这是**进程级**值，不是「这条请求骑的地址」，并发下必错。诊断
 * 用途尚可，绝不能当 failedEgress 传给 asip —— 用 asipEgressForPort(proxyUrl)。
 */
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

