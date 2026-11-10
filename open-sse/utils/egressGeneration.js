/**
 * 出口连接池的 generation 账本，按端口分账。
 *
 * Bun sidecar 按 (proxy, sessionGeneration) 分桶复用 FetchSession；Node 侧
 * undici 按 proxy URL 缓存 ProxyAgent。以前只有一个模块级整数，两个毛病：
 *   ① 任意一条线出事就 bump 全局，另外 5 个端口的健康连接一起被判死刑；
 *   ② asip 单方面重启隧道时 9router 不知情，整数不动，半开 socket 一直被
 *      复用，直到某条请求白等满 20s（诊断第十三、十四节）。
 *
 * 这里拆成 globalGen（兼容旧的无参换线调用）+ perPort（只失效出事的端口）。
 * 纯状态模块，不 import 任何业务模块，避免与 asipRotate / proxyFetch 成环。
 */
const perPort = new Map();      // "7890" -> number
const lastBumpAt = new Map();   // "7890" -> epoch ms
let globalGen = 0;

// 一波并发请求会同时撞上同一条死连接，各自 bump 只会把 generation 推高、多建
// 几个空 session。合并成一次即可：重试读的是「当前」generation，不是 bump 的
// 返回值，所以节流不会让任何请求骑回旧池。
const BUMP_GAP_MS = Math.max(0, Number(process.env.EGRESS_GEN_BUMP_GAP_MS || 1000));

function portOf(proxyUrl) {
  const m = /:(\d+)\/?$/.exec(String(proxyUrl || "").trim());
  return m ? m[1] : null;
}

/** 让某个端口的池化连接失效；不传 proxyUrl 时保留旧的全局 bump 语义。 */
export function bumpEgressGeneration(proxyUrl = null, { force = false, now = Date.now() } = {}) {
  const port = portOf(proxyUrl);
  if (!port) {
    globalGen += 1;
    return generationFor(proxyUrl);
  }
  if (!force && now - (lastBumpAt.get(port) || 0) < BUMP_GAP_MS) {
    return generationFor(proxyUrl);
  }
  lastBumpAt.set(port, now);
  perPort.set(port, (perPort.get(port) || 0) + 1);
  return generationFor(proxyUrl);
}

/** sidecar 的 session key；按端口分账，全局 bump 依旧影响所有端口。 */
export function generationFor(proxyUrl) {
  const port = portOf(proxyUrl) || "direct";
  return `g${globalGen}:p${port}:${perPort.get(port) || 0}`;
}

export function egressGenerationSnapshotForTest() {
  return { globalGen, perPort: Object.fromEntries(perPort) };
}

export function resetEgressGenerationForTest() {
  perPort.clear();
  lastBumpAt.clear();
  globalGen = 0;
}
