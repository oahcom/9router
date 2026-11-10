import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { asipRotationEnabled, rotateEgress } from "../utils/asipRotate.js";

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
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, replayBudget = false }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    // 连接超时换线只能发生一次：置位后再超时就照直抛，不让「换线→重试→再换线」
    // 滚成重试风暴（一次请求最多多等一个 60s 窗口）。
    let connectTimeoutRotated = false;
    const retryAttemptsByUrl = {};

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
      const transformedBody = this.transformRequest(model, body, stream, credentials);
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
        }, proxyOptions, log);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

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
              && await this.rotateEgressForConnectTimeout({ url, proxyOptions, log, signal })) {
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
