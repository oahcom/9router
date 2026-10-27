// A private address must never be handed to a remote egress.
//
// 2026-10-28: `settings.outboundProxyEnabled=1` exports HTTP(S)_PROXY
// process-wide (src/lib/network/outboundProxy.js). Requests with no pool of
// their own — a LAN peer at http://192.168.1.97:20127/v1 — resolved that env
// proxy, so sing-box pushed the private address into its 83-node public pool.
// Every attempt answered 502 after a connect timeout; measured 235s each,
// 108 failures / 0 successes in 30 minutes.
//
// NO_PROXY cannot express this: its matcher (shouldBypassByNoProxy) compares
// exact hosts and dot-suffixes, so `192.168.0.0/16` matches nothing. The rule
// has to live in the resolver.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEnvProxyUrl, isPrivateHost, resolveConnectionProxyUrl } from "../../open-sse/utils/proxyResolution.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const PROXY = "http://127.0.0.1:7890";
let saved;

beforeEach(() => {
  saved = { ...process.env };
  process.env.HTTP_PROXY = PROXY;
  process.env.HTTPS_PROXY = PROXY;
  process.env.ALL_PROXY = PROXY;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
});

afterEach(() => {
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "no_proxy"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("private hosts are not proxied", () => {
  it("never returns an env proxy for a LAN peer", () => {
    // The exact address that burned 108 requests: a second 9router instance on
    // the same LAN. Reaching it requires this machine's own network.
    expect(getEnvProxyUrl("http://192.168.1.97:20127/v1/models")).toBeNull();
  });

  it("never returns an env proxy for loopback or bare hostnames", () => {
    expect(getEnvProxyUrl("http://127.0.0.1:20127/v1")).toBeNull();
    expect(getEnvProxyUrl("http://localhost:8890/health")).toBeNull();
    expect(getEnvProxyUrl("http://[::1]:20127/")).toBeNull();
  });

  it("still proxies public targets", () => {
    // The bypass must be scoped to private addresses — dropping the env proxy
    // for public traffic would silently expose the real egress IP.
    expect(getEnvProxyUrl("https://opencode.ai/inference/v1/chat/completions")).toBe(PROXY);
    expect(getEnvProxyUrl("https://api.github.com/zen")).toBe(PROXY);
  });
});

describe("regression guard: the fetch path, not just the resolver", () => {
  it("does not build a proxy dispatcher for a private target", async () => {
    // 2026-10-28 的真实故障：proxyFetch.js 曾自带一份 getEnvProxyUrl 副本，
    // 规则只加在 proxyResolution 上，于是 proxyAwareFetch 仍把 LAN peer 交给
    // 127.0.0.1:7890。这里从调用方入口断言，副本再出现时测试会红。
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), dispatcher: init?.dispatcher ?? null });
      return new Response("ok", { status: 200 });
    };
    try {
      const response = await proxyAwareFetch("http://192.168.1.97:20127/v1/models", { method: "GET" });
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].dispatcher).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips a connection-level proxy for private targets too", () => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: PROXY };
    expect(resolveConnectionProxyUrl("http://192.168.1.97:20127/v1", proxyOptions)).toBeNull();
    expect(resolveConnectionProxyUrl("https://api.github.com/zen", proxyOptions)).toBe(PROXY);
  });
});

describe("isPrivateHost covers RFC1918 + loopback only", () => {
  it.each([
    ["192.168.1.97", true],
    ["10.1.2.3", true],
    ["172.16.0.5", true],
    ["172.31.255.254", true],
    ["127.0.0.1", true],
    ["localhost", true],
    ["169.254.1.1", true],
    ["::1", true],
    ["fd00::1", true],
    ["[::1]", true],
    ["[::ffff:192.168.1.97]", true],  // WHATWG URL normalizes this to ::ffff:c0a8:161
    ["[::ffff:c0a8:161]", true],
    ["[fe80::1]", true],
    ["[fd12:3456::1]", true],
    ["100.64.0.1", true],             // CGNAT
    ["0.0.0.0", true],
    ["metadata.google.internal", true],
  ])("treats %s as private", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it.each([
    ["172.32.0.5", false],   // one octet past the RFC1918 172.16/12 range
    ["100.128.0.1", false],  // one octet past CGNAT 100.64/10
    ["8.8.8.8", false],
    ["10.example.com", false], // 前缀匹配会把公网域名误判成私有（泄漏真实出口 IP）
    ["127.example.com", false],
    ["[::ffff:8.8.8.8]", false],
    ["[2001:4860:4860::8888]", false],
    ["opencode.ai", false],
  ])("treats %s as public", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});
