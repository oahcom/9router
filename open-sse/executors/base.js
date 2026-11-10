import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch, clearProxyDispatchers } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { asipRotationEnabled, rotateEgress, asipEgressForPort } from "../utils/asipRotate.js";

// 只有经本机 sing-box 出去的流量才受 asip 换线影响 —— 换的是 sing-box 里那条
// WARP 线的 selector。局域网里另一台机器的 7890（192.168.100.104:7890）是别人
// 的 sing-box，直连的 provider 更是碰都不碰 sing-box；对这些流量 /rotate 只是
// 白烧一条本地出口，还会把好线换走。
const ASIP_PROXY_PORTS = new Set(
  String(process.env.ASIP_LOCAL_PROXY_PORT || "7890,7892,7893,7894,7895,7896")
    .split(",").map(s => s.trim()).filter(Boolean));
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// 连接超时换线的冷却。一条真的坏掉的端点（域名写错、对端长期不可达）会持续
// 连接失败，每个请求都换一次线就是把出口池当消耗品烧。15s 内只换一次：真正
// 的隧道故障也远慢于这个节奏，而 429/quota 那条路径另有 asip 自己的合并与
// 最小间隔（coalesce 800ms / min_gap 1.5s）兜着。
const CONNECT_TIMEOUT_ROTATE_COOLDOWN_MS = 15000;
let lastConnectTimeoutRotateAt = 0;

// 429 一条请求最多打几发（含首发）。
//
// 这里以前是「只打一发」：DEFAULT_RETRY_CONFIG 把 429 设成 attempts: 0（上游
// 限流窗口不是秒级，原地退避重打只会再撞同一个窗口），而 shouldRetry(429) 只在
// 还有 fallback URL 时才换地址。两条都不换出口，于是兼容通道撞上按出口限流的
// 上游时就地失败 —— 实测 95 分钟内 35 条最终 429 全部是这一条路径、0 次换线，
// 而同一时刻走 opencode 的 81 条全部换过线。换出口是 asip 的事，与执行器无关，
// 所以这里补上同一套「换线再打」，判据仍然是「这条请求是否经本机 sing-box」。
const MAX_429_SENDS = Math.max(1, Number(process.env.EGRESS_429_SENDS || 3));
const ROTATE_429_BUDGET_MS = Number(process.env.EGRESS_429_BUDGET_MS || 25000);

/** 测试隔离用：进程里不需要。 */
export function resetConnectTimeoutRotateState() {
  lastConnectTimeoutRotateAt = 0;
}

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  /**
   * 429 换线重试由子类自己接管吗？
   *
   * opencode 有自己的三发循环（换线、记账、按 Retry-After 判停都在它那边），
   * 基类再套一层就变成 3×3 发。默认 false：兼容通道以前 429 只打一发，正是
   * 因为这里没有任何人接手。
   */
  handlesOwnEgress429() {
    return false;
  }

  /**
   * 连接阶段超时是否值得换一次出口。
   *
   * 判据是「这条请求实际是不是经本机 sing-box 出去」：连响应头都建不起来说明
   * 问题在出口链路而不是上游业务慢，这类超时换线后重试有意义；直连、或走局域网
   * 里另一台机器的 7890 时，换本机 WARP 线改变不了任何东西，只会白烧一条好线。
   */
  shouldRotateOnConnectTimeout(proxyOptions) {
    if (!asipRotationEnabled()) return false;
    const rawUrl = proxyOptions?.url ?? proxyOptions?.connectionProxyUrl;
    if (!rawUrl) return false;
    try {
      const parsed = new URL(String(rawUrl));
      if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false;
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return ASIP_PROXY_PORTS.has(port);
    } catch {
      return false;
    }
  }

  /**
   * 连接超时后换一次出口；换成功才允许重试。
   *
   * 返回 false 的三种情况都当作「没换」：asip 关着、代理不是本机 sing-box、
   * 冷却窗口内已经换过。此时保持原来「直接抛」的行为，不再白等第二个 60s。
   */
  async rotateEgressForConnectTimeout({ url, proxyOptions, log, signal }) {
    if (!this.shouldRotateOnConnectTimeout(proxyOptions)) return false;
    const now = Date.now();
    if (now - lastConnectTimeoutRotateAt < CONNECT_TIMEOUT_ROTATE_COOLDOWN_MS) {
      log?.debug?.("EGRESS", `connect timeout on ${url}: rotation in cooldown, not rotating`);
      return false;
    }
    lastConnectTimeoutRotateAt = now;
    const proxyUrl = proxyOptions?.url ?? proxyOptions?.connectionProxyUrl ?? null;
    const res = await rotateEgress("transport", { signal, proxyUrl });
    // switched=false 可能只是并发合并（别人刚换过），switchedAt 才能证明「确实换过」。
    const rotated = Boolean(res?.switched) || Number(res?.switchedAt || 0) > 0;
    log?.warn?.(
      "EGRESS",
      `connect timeout on ${url} -> asip rotate ${rotated ? res.reason : res?.reason || "unavailable"}`
        + (rotated ? ", retry once" : ", no retry"),
    );
    return rotated;
  }

  /**
   * 429 换一次出口，返回「这一发该走哪个代理」；null 表示不要再打。
   *
   * 与 rotateEgressForConnectTimeout 同一条判据（只对本机 sing-box 有意义），
   * 但语义不同：连接超时是「出口死了」，429 是「这个出口的额度用完了」。
   * 两者都必须先换出口再重发 —— 不换出口的重发在上游看来就是同一条 /128 的
   * 第二次请求，只会拿到同一个 429。
   */
  async rotateEgressFor429({ url, proxyOptions, log, signal, reqId, requestStartedAt, triedEgress = new Set(), sends = 1 }) {
    if (!this.shouldRotateOnConnectTimeout(proxyOptions)) return null;
    if (sends >= MAX_429_SENDS) {
      log?.warn?.("EGRESS", `429 on ${url}: ${sends} sends used, giving up`);
      return null;
    }
    if (Date.now() - requestStartedAt > ROTATE_429_BUDGET_MS) {
      log?.warn?.("EGRESS", `429 on ${url}: rotate budget spent after ${sends - 1} retry, giving up`);
      return null;
    }
    const proxyUrl = proxyOptions?.url ?? proxyOptions?.connectionProxyUrl ?? null;
    // 换线前的出口身份：按端口取。进程级快照（currentAsipEgress）在并发下会被
    // 别的请求覆写，把无辜的地址报给 asip 当「刚撞墙的地址」。
    const before = await asipEgressForPort(proxyUrl, { signal });
    let res = null;
    try {
      res = await rotateEgress("rate429", {
        signal,
        requestStartedAt,
        proxyUrl,
        reqId,
        failedEgress: before?.egress || null,
        failedEgressSince: before?.since || null,
      });
    } catch (error) {
      log?.warn?.("EGRESS", `429 rotate failed on ${proxyUrl || "-"}: ${error?.message || error}`);
      return null;
    }
    if (!res || res.restartRequired) return null;
    const targetUrl = res.switchToUrl || null;
    const targetEgress = res.switchToEgress || res.activeEgress || null;
    const samePort = !targetUrl || targetUrl === proxyUrl;
    // 原地打转：同端口、且拿不到一个跟上一发不同的地址。asip 的 already_retired
    // 走这条分支（线已经换过、重连即用新地址），此时 activeEgress 是新地址，
    // 可以通过；而 coalesced / line_ok / 把同一 /128 换个闸还回来，都过不去。
    const repeats = Boolean(targetEgress)
      && (targetEgress === before || triedEgress.has(targetEgress));
    if (repeats) {
      log?.warn?.(
        "EGRESS",
        `429 on ${proxyUrl || "-"} -> retry refused: egress ${targetEgress} already used (reason ${res.reason})`,
      );
      return null;
    }
    if (samePort && !targetEgress) {
      // asip 证明过「这条请求发出之后线被换过」：同端口重连拿到的就是新地址。
      // already_retired 本身就是这个结论（它只在 exit ledger 里这条地址的退役
      // 时刻晚于请求发出时才回），switchedAt 反而是更早的时刻，不能拿来否决。
      const lineMoved = res.reason === "already_retired"
        || Number(res.switchedAt || 0) >= requestStartedAt;
      if (lineMoved) {
        log?.warn?.(
          "EGRESS",
          `429 on ${proxyUrl || "-"} -> reconnect same port (${res.reason}, line switched after request start)`,
        );
        return { proxyOptions, egress: null };
      }
      log?.warn?.(
        "EGRESS",
        `429 on ${proxyUrl || "-"} -> retry refused: no new line (reason ${res.reason}, switchedAt ${res.switchedAt || 0})`,
      );
      return null;
    }
    if (targetEgress) triedEgress.add(targetEgress);
    log?.warn?.(
      "EGRESS",
      `429 on ${proxyUrl || "-"} -> retry on ${targetUrl || proxyUrl} (${res.reason}, egress ${targetEgress || "unknown"})`,
    );
    return {
      proxyOptions: targetUrl
        ? { ...proxyOptions, url: targetUrl, enabled: true }
        : proxyOptions,
      egress: targetEgress,
    };
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }
  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  // 选出口的唯一入口：默认走 proxyAwareFetch，子类（opencode）覆盖它去接 Bun
  // sidecar / wreq-js。上游 ce060c79 走的是 execute 的 directFetch 实参，这里换成
  // 覆写钩子，所以 base.execute 不再需要那个形参（没人会传）。
  fetchUpstream(url, options, proxyOptions = null) {
    return proxyAwareFetch(url, options, proxyOptions);
  }

  // replayBudget 只在「传输层卡死后换线重放」那一次为 true：给首字节多留时间。
  // 首次尝试必须保持快判（20s），否则一条死出口会白白拖满 45s。
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, replayBudget = false, reqId = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    // 连接超时换线只能发生一次：置位后再超时就照直抛，不让「换线→重试→再换线」
    // 滚成重试风暴（一次请求最多多等一个 60s 窗口）。
    let connectTimeoutRotated = false;
    const retryAttemptsByUrl = {};

    // 429 换线重试的状态。egressProxyOptions 是本发实际用的出口，换线后指向
    // asip 指定的那台闸；triedEgress 记本请求打过的地址，防止同一 /128 反复打。
    const requestStartedAt = Date.now();
    let egressProxyOptions = proxyOptions;
    let sends = 1; // 首发
    const triedEgress = new Set();
    // 重放要求 body 可重放：transformRequest 可能就地改 body（打指纹、改工具名），
    // 第二发拿着改过的对象再改一次必然 403。只在「可能换线」时才克隆，避免给
    // 直连/大 body 的请求白付一次深拷贝。
    let replayBody = null;
    if (asipRotationEnabled() && this.shouldRotateOnConnectTimeout(proxyOptions)) {
      try {
        replayBody = body && typeof body === "object" ? structuredClone(body) : null;
      } catch {
        replayBody = null; // 不可克隆（含 Blob/流）：照旧只打一发，不冒险重放
      }
    }

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, replayBody || body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model, transformedBody);
      // User per-provider override wins over registry headers (blocked names filtered at the API)
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await this.fetchUpstream(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal,
          ...(replayBudget ? { replayBudget: true } : {}),
        }, egressProxyOptions, log);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        // 429 先换出口再重打。必须放在 tryRetry 之前：retryConfig 里 429 是
        // attempts: 0（不换出口的重发等于再撞一次同一个窗口），shouldRetry 只在
        // 还有 fallback URL 时才换地址 —— 兼容通道原本两条都不走，于是只打一发。
        if (!this.handlesOwnEgress429()
            && response.status === HTTP_STATUS.RATE_LIMITED
            && (replayBody || typeof body === "string")) {
          const next = await this.rotateEgressFor429({
            url,
            proxyOptions: egressProxyOptions,
            log,
            signal,
            reqId,
            requestStartedAt,
            triedEgress,
            sends,
          });
          if (next) {
            egressProxyOptions = next.proxyOptions;
            sends += 1;
            // 换的是出口不是 URL：fallback 序号不能前进，重打同一个上游地址。
            clearProxyDispatchers();
            urlIndex--;
            continue;
          }
        }

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // 60s 内连响应头都没拿到 = 这条出口已经死了。重试同一个 URL 只是把
        // 60s 再走一遍（实测 4 次 ≈ 236s 才回 502，而外层 combo 本来就有自己的
        // 降级）。改为主张换 fallback URL，没有就直接抛出。
        if (isConnectTimeout) {
          if (urlIndex + 1 < fallbackCount) {
            log?.debug?.("RETRY", `header timeout on ${url}, trying fallback ${urlIndex + 1}`);
            continue;
          }
          // 最后一个 URL 也建不起连接：出口链路大概率已经不通（WARP 线被烧、
          // 隧道半死），换一条出口再试一次，比把 502 直接甩给客户端有用。
          // 只换一次 —— 见 connectTimeoutRotated 的注释。
          if (!connectTimeoutRotated
              && await this.rotateEgressForConnectTimeout({ url, proxyOptions: egressProxyOptions, log, signal })) {
            connectTimeoutRotated = true;
            urlIndex--;
            continue;
          }
          throw error;
        }

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
