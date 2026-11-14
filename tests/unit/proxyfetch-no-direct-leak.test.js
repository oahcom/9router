import { describe, expect, it, vi } from "vitest";

// 杜绝真实 IP 泄漏契约测试（2026-11-15 生产事故）：
// 隧道被掐 -> 换线全挂 -> 旧代码 "falling back to direct" 把请求从真实 IP 发出去。
// 契约：代理意图明确时（proxyUrl 已配置）失败必须 fail-hard，绝不 directSend。
// 只有显式 allowDirectFallback=true 才保留旧行为。
// 注意：loopback/RFC1918 目标按设计不过代理（见 local-target-bypasses-env-proxy），
// 所以这里用 TEST-NET-1（192.0.2.1）保证请求走上代理路径。
// 签名：proxyAwareFetch(url, options, proxyOptions) —— 代理配置在第三参。

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

function deadProxyOptions() {
  return {
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://127.0.0.1:7890", // 未监听端口 -> 代理链必失败（ECONNREFUSED 速败）
    connectionNoProxy: "",
    strictProxy: false,
  };
}

describe("no real-IP leak on proxy failure", () => {
  it("throws instead of falling back to direct when the proxy chain fails", async () => {
    let err = null;
    try {
      await proxyAwareFetch("http://192.0.2.1:9/v1/models", { method: "GET" }, deadProxyOptions());
    } catch (e) {
      err = e;
    }
    expect(err, "代理链失败必须抛错，绝不能静默落到 direct").toBeTruthy();
    expect(String(err?.message || err)).toMatch(/refusing direct fallback \(IP leak\)/);
  });

  it("allows the legacy direct fallback only with explicit allowDirectFallback", async () => {
    let err = null;
    try {
      await proxyAwareFetch("http://192.0.2.1:9/v1/models", { method: "GET" }, {
        ...deadProxyOptions(),
        allowDirectFallback: true,
      });
    } catch (e) {
      err = e;
    }
    // 旧契约保留：允许 fallback -> 错误不是 "refusing direct fallback"（direct 打
    // 192.0.2.1:9 自身也会失败，但不再带 IP-leak 守卫文案）。
    if (err) {
      expect(String(err?.message || err)).not.toMatch(/refusing direct fallback/);
    }
  });
});
