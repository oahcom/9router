import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 请求级上下文：只装一个 reqId。
 *
 * 为什么需要它：换线动作发生在三层（executor 的 429 分支、base 的连接超时分支、
 * proxyFetch 的连接失败分支），其中 proxyFetch 那一层拿不到 reqId —— 它在
 * fetch 的调用栈深处，签名里没有也不该有请求标识。结果是 281 条 transport
 * 报障在 asip 侧全是 `req=-`，既不能按请求串日志，也不能按请求核对换线效果。
 *
 * AsyncLocalStorage 沿 await 链自动传播，一次 run 覆盖整条请求路径，不需要给
 * 每层加参数。
 */
const storage = new AsyncLocalStorage();

export function runWithReqId(reqId, fn) {
  if (!reqId) return fn();
  return storage.run({ reqId }, fn);
}

export function currentReqId() {
  return storage.getStore()?.reqId || null;
}
