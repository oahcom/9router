import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Source paths are repo-relative; vitest runs from tests/, so resolve from the repo root.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ============================================================
// AUDIT-002 (#1962): API key masking in usage stats
// ============================================================
describe("AUDIT-002: API key masking", () => {
  it("source should contain maskApiKey function", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    expect(source).toContain("function maskApiKey");
  });

  it("getUsageHistory should use apiKeyMasked instead of apiKey", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // The REST response should use apiKeyMasked
    expect(source).toContain("apiKeyMasked: maskApiKey(r.apiKey)");
    // The return mapping in getUsageHistory should not have raw apiKey
    // (The internal ring buffer still uses apiKey: r.apiKey for internal state - that's fine)
    const historyReturn = source.match(/return rows\.map\(\(r\)\s*=>\s*\(\{[\s\S]*?\}\)\);/);
    expect(historyReturn).not.toBeNull();
    expect(historyReturn[0]).toContain("apiKeyMasked");
    expect(historyReturn[0]).not.toContain("apiKey: r.apiKey");
  });

  it("getUsageStats masks the key value and hashes the bucket key", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // 两条路径（日汇总 + 24h 实时）都要把 key 掩码后放进 value 里
    const maskedCount = (source.match(/apiKeyMasked/g) || []).length;
    expect(maskedCount).toBeGreaterThanOrEqual(3);

    // 桶键一律交给 byApiKeyId（哈希），不是原始 key，也不是掩码
    expect(source).toContain("byApiKeyId(apiKeyVal)");
    expect(source).toContain("byApiKeyId(r.apiKey)");
    expect(source).toContain("byApiKeyId(e.apiKey)");
  });

  it("byApiKey bucket keys never carry the raw key", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // 2026-10-28 之前这里是反过来的：桶键直接拼原始 key（会 JSON.stringify 进
    // usageDaily，也会作为 /api/usage/stats 的键发出去）。掩码又不行 —— 同前缀
    // 的团队 key 会撞成一个桶。所以现在的契约是：哈希做桶 id，原始 key 只留在
    // meta.apiKey 里供查名字用。
    expect(source).not.toContain("${r.apiKey}|${r.model}|${r.provider");
    expect(source).not.toContain("${e.apiKey}|${e.model}|${e.provider");
    expect(source).not.toContain("${apiKeyVal}|${entry.model}");
    // 出口收口：历史行里第一段是原始 key，读的时候再哈希一遍
    expect(source).toContain("sanitizeByApiKeyKey(bucketKey)");
  });
});

// ============================================================
// AUDIT-003 (#1961): Proxy URL validation
// ============================================================
describe("AUDIT-003: Proxy URL validation", () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
    delete process.env.NINE_ROUTER_PROXY_URL;
    delete process.env.NINE_ROUTER_NO_PROXY;
    delete process.env.NO_PROXY;
  });

  it("source should contain validateProxyUrl function", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/network/outboundProxy.js"),
      "utf-8"
    );
    expect(source).toContain("function validateProxyUrl");
    expect(source).toContain("ALLOWED_PROXY_SCHEMES");
  });

  it("should accept valid http proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080",
    });
    // new URL().href normalizes (adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("http://proxy.example.com:8080");
    expect(process.env.HTTPS_PROXY).toContain("http://proxy.example.com:8080");
  });

  it("should accept valid https proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "https://proxy.example.com:443",
    });
    // new URL().href normalizes (drops default port 443, adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("https://proxy.example.com");
  });

  it("should accept valid socks5 proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "socks5://proxy.example.com:1080",
    });
    expect(process.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
  });

  it("should reject URLs with shell metacharacters (newline)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080\nmalicious",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (backtick)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://`whoami`.example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (dollar)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://$(whoami).example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (file://)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "file:///etc/passwd",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (javascript:)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "javascript:alert(1)",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});

// ============================================================
// AUDIT-018 (#1972): XSS escaping in OAuth callback
// ============================================================
describe("AUDIT-018: XSS escaping in OAuth callback", () => {
  it("source should contain escapeHtml function", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("function escapeHtml");
  });

  it("should escape ampersand, angle brackets, and quotes", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("&amp;");
    expect(source).toContain("&lt;");
    expect(source).toContain("&gt;");
    expect(source).toContain("&quot;");
    expect(source).toContain("&#39;");
  });

  it("should use safeMessage in rendered HTML, not raw message", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("safeMessage");
    expect(source).toContain("${safeMessage}");
    // Should NOT use raw message in HTML body
    expect(source).not.toContain("<p>${message}</p>");
  });
});

// ============================================================
// AUDIT-004 (#1963): TOCTOU race - atomic lock file
// ============================================================
describe("AUDIT-004: Atomic lock file for MITM startup", () => {
  it("manager.js should define LOCK_FILE constant", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain("LOCK_FILE");
    expect(source).toContain(".mitm.lock");
  });

  it("should use O_EXCL flag (wx) for atomic creation", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain('"wx"');
    expect(source).toContain("EEXIST");
  });

  it("should clean up lock file on all exit paths", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );
    const matches = source.match(/unlinkSync\(LOCK_FILE\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// AUDIT-001 (#1965): Race condition in retry tracking
// ============================================================
describe("AUDIT-001: Synchronous restart guard", () => {
  it("mitmIsRestarting should be set before first await expression", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    expect(funcStart).toBeGreaterThan(-1);

    const funcBody = source.substring(funcStart, funcStart + 2000);

    const guardCheckIdx = funcBody.indexOf("if (mitmIsRestarting) return;");
    expect(guardCheckIdx).toBeGreaterThan(-1);

    const afterGuard = funcBody.substring(guardCheckIdx);

    // Strip line comments to avoid matching "await" in comment text
    const noComments = afterGuard.replace(/\/\/.*$/gm, "");

    // Find the first actual await expression
    const firstAwaitIdx = noComments.search(/\bawait\s+/);
    expect(firstAwaitIdx).toBeGreaterThan(-1);

    // Find mitmIsRestarting = true
    const setFlagIdx = noComments.indexOf("mitmIsRestarting = true");

    expect(setFlagIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(setFlagIdx).toBeLessThan(firstAwaitIdx);
  });

  it("mitmIsRestarting should be reset on max-restarts early return", () => {
    const source = fs.readFileSync(
      path.resolve(REPO_ROOT, "src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    const funcBody = source.substring(funcStart, funcStart + 2000);

    const maxRestartsIdx = funcBody.indexOf("Max restart attempts reached");
    expect(maxRestartsIdx).toBeGreaterThan(-1);

    const afterMax = funcBody.substring(maxRestartsIdx, maxRestartsIdx + 200);
    expect(afterMax).toContain("mitmIsRestarting = false");
  });
});
