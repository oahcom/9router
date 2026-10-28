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

import { getEnvProxyUrl, isLinkLocalOrMetadataHost, isPrivateHost, resolveConnectionProxyUrl } from "../../open-sse/utils/proxyResolution.js";
import { readFileSync } from "node:fs";
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
  // 2026-10-28 的真实故障：proxyFetch.js 曾自带一份 getEnvProxyUrl 副本，规则只
  // 加在 proxyResolution 上，于是 proxyAwareFetch 仍把 LAN peer 交给 127.0.0.1:7890。
  // proxyFetch 在模块加载时捕获 globalThis.fetch，无法用替换 fetch 观测调用路径，
  // 所以直接守住"副本不得复活"这个不变量。
  it("keeps a single definition of the proxy-rule helpers", () => {
    const source = readFileSync(
      new URL("../../open-sse/utils/proxyFetch.js", import.meta.url),
      "utf8"
    );
    for (const helper of ["getEnvProxyUrl", "shouldBypassByNoProxy", "normalizeProxyUrl", "resolveConnectionProxyUrl"]) {
      expect(source).not.toMatch(new RegExp(`function\\s+${helper}\\s*\\(`));
    }
    expect(source).toContain('from "./proxyResolution.js"');
  });

  it("skips a connection-level proxy for private targets too", () => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: PROXY };
    expect(resolveConnectionProxyUrl("http://192.168.1.97:20127/v1", proxyOptions)).toBeNull();
    expect(resolveConnectionProxyUrl("https://api.github.com/zen", proxyOptions)).toBe(PROXY);
  });

  // 链路本地/元数据端点反过来：它们只能靠代理挡住。把面板里可自由填写的
  // baseUrl 指向 169.254.169.254 时，直连就是一台无鉴权的云元数据读取器。
  it("keeps link-local and metadata targets on the proxy", () => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: PROXY };
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[fe80::1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      expect(resolveConnectionProxyUrl(target, proxyOptions)).toBe(PROXY);
      expect(getEnvProxyUrl(target)).toBe(PROXY);
    }
  });

  // 代理失败后 proxyFetch 会 `falling back to direct`（2026-10-28 在 aihub 连接上
  // 把 baseUrl 指到 169.254.169.254 实测到该日志）。所以这类目标不能只靠
  // 「保留代理」，必须在入口拒绝，否则一次失败重试就把元数据读出来了。
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[fe80::1]/",
  ])("refuses %s without attempting a direct fetch", async (target) => {
    const started = Date.now();
    await expect(proxyAwareFetch(target, { method: "GET" })).rejects.toThrow(/refused link-local\/metadata/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("leaves loopback and RFC1918 targets alone", async () => {
    const src = readFileSync(new URL("../../open-sse/utils/proxyFetch.js", import.meta.url), "utf8");
    expect(src).toContain("isLinkLocalOrMetadataHost(hostnameOf(targetUrl))");
    expect(isLinkLocalOrMetadataHost("127.0.0.1")).toBe(false);
    expect(isLinkLocalOrMetadataHost("192.168.1.97")).toBe(false);
  });

  it("still sends plain private peers direct when no connection proxy is set", () => {
    for (const target of ["http://192.168.1.97:20127/v1", "http://10.0.0.5/", "http://nas.lan/"]) {
      expect(getEnvProxyUrl(target)).toBeNull();
      expect(resolveConnectionProxyUrl(target, {})).toBeNull();
    }
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
    ["nas.lan", true], // ICANN 未委派 .lan，局域网常见简写
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

  it.each([
    ["169.254.169.254", true],
    ["[::ffff:169.254.169.254]", true],
    ["[fe80::1]", true],
    ["metadata.google.internal", true],
    ["192.168.1.97", false],
    ["10.0.0.5", false],
    ["127.0.0.1", false],
    ["[fd00::1]", false],
  ])("classifies %s as link-local/metadata=%s", (host, expected) => {
    expect(isLinkLocalOrMetadataHost(host)).toBe(expected);
  });
});

// 2026-10-28 reviewer P1：上面 45 条用例覆盖的形状恰好等于实现支持的范围，
// 所以全绿不能证明「元数据端点已全部堵住」。缺的正是云厂商实际公布的那几个地址。
// 判据是「是否被拒绝」，不是「是否被归为 private」——四类里前三类在 isPrivateHost
// 眼里本来就是 private，走的是直连分支，从来没经过代理。
describe("cloud metadata endpoints outside 169.254/16", () => {
  // 100.64/10 内，但整段不能拒：同段还有 tailnet 与 CGNAT 对等体。
  it.each([
    "100.100.100.200", // Aliyun
    "168.63.129.16", // Azure WireServer / IMDS
    "192.0.0.192", // Oracle Cloud
  ])("refuses %s", (host) => {
    expect(isLinkLocalOrMetadataHost(host)).toBe(true);
  });

  // fc00::/7 内，同样只拒这一个：fd00::1 是普通局域网 IPv6。
  it("refuses fd00:ec2::254 but keeps other ULA addresses direct", () => {
    expect(isLinkLocalOrMetadataHost("[fd00:ec2::254]")).toBe(true);
    expect(isLinkLocalOrMetadataHost("[fd00::1]")).toBe(false);
  });

  // `.internal` 整后缀不能拒：本仓自己的服务就用它（huggingface 适配器 fixture 是 tgi.internal）。
  it.each([
    ["metadata.azure.internal", true],
    ["instance-data.internal", true],
    ["instance-data.ec2.internal", true],
    ["tgi.internal", false],
  ])("classifies %s as metadata=%s", (host, expected) => {
    expect(isLinkLocalOrMetadataHost(host)).toBe(expected);
  });

  // 段与名字都没放宽的旁证：CGNAT / ULA 里随便挑的地址仍是直连，不算被拒。
  it.each(["100.64.0.1", "100.127.255.254", "[fd12:3456::1]"])("keeps %s direct", (host) => {
    expect(isLinkLocalOrMetadataHost(host)).toBe(false);
  });

  // 拒绝必须发生在发出任何请求之前（否则一次代理失败回落直连就把它读出来了）。
  it.each([
    "http://100.100.100.200/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://metadata.azure.internal/metadata/instance",
    "http://instance-data.internal/latest/meta-data/",
    "http://192.0.0.192/opc/v2/instance/",
    "http://168.63.129.16/machine?comp=acisettings",
  ])("refuses %s without attempting a direct fetch", async (target) => {
    await expect(proxyAwareFetch(target, { method: "GET" })).rejects.toThrow(/refused link-local\/metadata/);
  });
});
