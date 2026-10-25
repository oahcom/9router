import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  identifyFixedEgress,
  markEgressCooling,
  getEgressCooldown,
  hasActiveDirectCooldown,
  selectAlternateProxy,
  alternateToProxyOptions,
  parseRetryAfterMs,
  resetEgressState,
  resolveEgress,
} from "../../open-sse/utils/egress.js";

const TARGET = "https://opencode.ai/inference/v1/chat/completions";

function pool(id, url, extra = {}) {
  return {
    proxyPoolId: id,
    connectionProxyEnabled: true,
    connectionProxyUrl: url,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
    ...extra,
  };
}

let savedEnv;

beforeEach(() => {
  resetEgressState();
  savedEnv = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    ALL_PROXY: process.env.ALL_PROXY,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEgressState();
});

function clearProxyEnv() {
  for (const key of Object.keys(savedEnv)) delete process.env[key];
}

describe("egress identity", () => {
  it("prefers a relay URL over a connection proxy", async () => {
    const egress = await resolveEgress({
      targetUrl: TARGET,
      proxyOptions: {
        vercelRelayUrl: "https://relay.example/",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.example:8080",
      },
    });

    expect(egress.kind).toBe("relay");
    expect(egress.confirmed).toBe(true);
    expect(egress.id).toMatch(/^relay:[0-9a-f]{32}$/);
    expect(egress.relayUrl).toBe("https://relay.example/");
  });

  it("identifies the effective connection proxy without exposing its URL in the id", async () => {
    const egress = await resolveEgress({
      targetUrl: TARGET,
      proxyOptions: pool("a", "http://user:secret@proxy.example:8080"),
    });

    expect(egress.kind).toBe("proxy");
    expect(egress.confirmed).toBe(true);
    expect(egress.id).toMatch(/^proxy:[0-9a-f]{32}$/);
    expect(egress.id).not.toContain("secret");
    expect(egress.proxyUrl).toBe("http://user:secret@proxy.example:8080");
  });

  it("honors NO_PROXY for the connection proxy", async () => {
    clearProxyEnv();
    const egress = await resolveEgress({
      targetUrl: TARGET,
      proxyOptions: pool("a", "http://proxy.example:8080", { connectionNoProxy: "opencode.ai" }),
    });

    expect(egress.kind).toBe("direct");
    expect(egress.confirmed).toBe(false);
  });

  it("identifies an environment proxy when no connection proxy applies", async () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://env-proxy.example:3128";
    const egress = await resolveEgress({
      targetUrl: TARGET,
      proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:8080", connectionNoProxy: "opencode.ai" },
    });

    expect(egress.kind).toBe("proxy");
    expect(egress.proxyUrl).toBe("http://env-proxy.example:3128");
  });

  it("returns an unconfirmed direct egress when no IP is known", async () => {
    clearProxyEnv();
    const egress = await resolveEgress({ targetUrl: TARGET, proxyOptions: null });

    expect(egress).toMatchObject({ id: "direct", kind: "direct", confirmed: false, ip: null });
  });
});

describe("egress cooldowns", () => {
  it("records and expires a cooldown for a confirmed egress", () => {
    const egress = identifyFixedEgress(TARGET, pool("a", "http://proxy.example:8080"));
    const entry = markEgressCooling(egress, 120_000);

    expect(entry.retryAfterMs).toBe(120_000);
    expect(getEgressCooldown(egress)?.retryAfterMs).toBeGreaterThan(110_000);
    expect(getEgressCooldown(egress.id, Date.now() + 121_000)).toBeNull();
  });

  it("clamps cooldowns to the configured bounds", () => {
    const egress = identifyFixedEgress(TARGET, pool("a", "http://proxy.example:8080"));

    expect(markEgressCooling(egress, 1).retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(markEgressCooling(egress, 10 * 24 * 60 * 60 * 1000).retryAfterMs).toBe(24 * 60 * 60 * 1000);
  });

  it("never cools an unconfirmed direct egress", () => {
    expect(markEgressCooling({ id: "direct", confirmed: false }, 60_000)).toBeNull();
    expect(getEgressCooldown("direct")).toBeNull();
  });

  it("detects an active direct-IP cooldown", () => {
    expect(hasActiveDirectCooldown()).toBe(false);
    markEgressCooling({ id: "direct:203.0.113.9", confirmed: true }, 60_000);
    expect(hasActiveDirectCooldown()).toBe(true);
  });
});

describe("alternate egress selection", () => {
  it("skips the current egress and cooling alternates, and clears stale aliases", () => {
    const current = pool("a", "http://proxy-a.example:8080");
    const b = pool("b", "http://proxy-b.example:8080");
    const c = pool("c", "http://proxy-c.example:8080");
    const proxyOptions = { ...current, connectionProxyAlternates: [b, c] };

    const idA = identifyFixedEgress(TARGET, current).id;
    const idB = identifyFixedEgress(TARGET, b).id;
    markEgressCooling(identifyFixedEgress(TARGET, current), 60_000);
    markEgressCooling(identifyFixedEgress(TARGET, b), 5_000);

    const selection = selectAlternateProxy(proxyOptions, TARGET, new Set([idA]));
    expect(selection.alternate?.egress.id).toBe(identifyFixedEgress(TARGET, c).id);
    expect(selection.alternate?.proxyOptions.url).toBe("http://proxy-c.example:8080");
    expect(selection.alternate?.proxyOptions.connectionProxyUrl).toBe("http://proxy-c.example:8080");
    expect(selection.alternate?.proxyOptions.vercelRelayUrl).toBe("");

    markEgressCooling(identifyFixedEgress(TARGET, c), 1_000);
    const allCooling = selectAlternateProxy(proxyOptions, TARGET, new Set([idA, idB]));
    expect(allCooling.alternate).toBeNull();
    expect(allCooling.earliestCooldownMs).toBeGreaterThan(0);
  });

  it("replaces every proxy alias when switching from a relay to a standard pool", () => {
    const merged = alternateToProxyOptions({
      url: "http://old-proxy.example:8080",
      connectionProxyUrl: "http://old-proxy.example:8080",
      noProxy: "old.example",
      vercelRelayUrl: "https://old-relay.example",
      connectionProxyEnabled: false,
    }, pool("b", "http://new-proxy.example:8080"));

    expect(merged.url).toBe("http://new-proxy.example:8080");
    expect(merged.connectionProxyUrl).toBe("http://new-proxy.example:8080");
    expect(merged.noProxy).toBe("");
    expect(merged.vercelRelayUrl).toBe("");
    expect(merged.connectionProxyEnabled).toBe(true);
  });
});

describe("Retry-After parsing", () => {
  it("reads seconds from the header", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "120" }))).toBe(120_000);
  });

  it("reads an HTTP date from the header", () => {
    const now = Date.now();
    const header = new Date(now + 60_000).toUTCString();
    const parsed = parseRetryAfterMs(new Headers({ "retry-after": header }), "", now);
    expect(parsed).toBeGreaterThan(55_000);
    expect(parsed).toBeLessThanOrEqual(60_000);
  });

  it("falls back to body fields, including nested and millisecond keys", () => {
    expect(parseRetryAfterMs(null, JSON.stringify({ error: { retry_after: 45 } }))).toBe(45_000);
    expect(parseRetryAfterMs(null, JSON.stringify({ error: { metadata: { retry_after_ms: 90_000 } } }))).toBe(90_000);
    expect(parseRetryAfterMs(null, JSON.stringify({ error: { resetsAt: new Date(Date.now() + 30_000).toISOString() } }))).toBeGreaterThan(20_000);
  });

  it("falls back to message text", () => {
    expect(parseRetryAfterMs(null, "Please try again in 2 minutes")).toBe(120_000);
    expect(parseRetryAfterMs(null, "rate limited; retry after 30s")).toBe(30_000);
  });

  it("lets the header win over the body", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "10" }), JSON.stringify({ retry_after: 500 }))).toBe(10_000);
  });

  it("reads x-ratelimit-reset-after", () => {
    expect(parseRetryAfterMs(new Headers({ "x-ratelimit-reset-after": "7" }))).toBe(7_000);
  });

  it("returns null when no retry hint exists", () => {
    expect(parseRetryAfterMs(new Headers(), JSON.stringify({ type: "error" }))).toBeNull();
  });
});
