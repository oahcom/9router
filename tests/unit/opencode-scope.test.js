import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getProviderConnections: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  proxyConfigFromPool: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
  proxyConfigFromPool: mocks.proxyConfigFromPool,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {
    opencode: { noAuth: true },
    "mimo-free": { noAuth: true },
    "free-rotating": { noAuth: true },
  },
  resolveProviderId: (provider) => (provider === "oc" ? "opencode" : provider),
}));

vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");
const { getExecutor, BaseExecutor } = await import("open-sse/executors/index.js");
const { OpenCodeExecutor } = await import("open-sse/executors/opencode.js");
const { OpenCodeGoExecutor } = await import("open-sse/executors/opencode-go.js");
const { OpenCodeZenExecutor } = await import("open-sse/executors/opencode-zen.js");

const POOLS = [
  { id: "pool-a", proxyUrl: "http://a.example:8080", isActive: true },
  { id: "pool-b", proxyUrl: "http://b.example:8080", isActive: true },
];

describe("OpenCode free lane provider isolation", () => {
  it("routes only opencode to OpenCodeExecutor", () => {
    expect(getExecutor("opencode")).toBeInstanceOf(OpenCodeExecutor);
    expect(getExecutor("opencode-go")).toBeInstanceOf(OpenCodeGoExecutor);
    expect(getExecutor("opencode-zen")).toBeInstanceOf(OpenCodeZenExecutor);
    expect(getExecutor("opencode-go")).not.toBeInstanceOf(OpenCodeExecutor);
    expect(getExecutor("opencode-zen")).not.toBeInstanceOf(OpenCodeExecutor);
  });

  it("keeps the transport override exclusive to opencode", () => {
    const ownsFetchUpstream = (ctor) => Object.prototype.hasOwnProperty.call(ctor.prototype, "fetchUpstream");

    expect(OpenCodeExecutor.prototype.fetchUpstream).not.toBe(BaseExecutor.prototype.fetchUpstream);
    expect(ownsFetchUpstream(OpenCodeExecutor)).toBe(true);
    expect(ownsFetchUpstream(OpenCodeGoExecutor)).toBe(false);
    expect(ownsFetchUpstream(OpenCodeZenExecutor)).toBe(false);
    expect(getExecutor("opencode-go").fetchUpstream).toBe(BaseExecutor.prototype.fetchUpstream);
    expect(getExecutor("opencode-zen").fetchUpstream).toBe(BaseExecutor.prototype.fetchUpstream);
  });

  it("keeps upstream URLs separate for each opencode provider", () => {
    const free = getExecutor("opencode");
    const go = getExecutor("opencode-go");
    const zen = getExecutor("opencode-zen");

    expect(free.buildUrl("deepseek-v4.1-flash-free")).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(go.buildUrl("deepseek-v4-flash")).not.toBe(free.buildUrl("deepseek-v4-flash"));
    expect(zen.buildUrl("deepseek-v4-flash")).not.toBe(free.buildUrl("deepseek-v4-flash"));
  });
});

describe("no-auth credential shape isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      providerStrategies: {
        opencode: { proxyPoolId: "pool-a" },
        "mimo-free": { proxyPoolId: "pool-b" },
        "free-rotating": { rotateStrategy: "round-robin" },
      },
    });
    mocks.getProxyPools.mockResolvedValue(POOLS);
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.pickProxyPoolId.mockImplementation((ids) => ids[0] || null);
    mocks.resolveConnectionProxyConfig.mockImplementation(async ({ proxyPoolId }) => ({
      proxyPoolId,
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://primary.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    }));
    mocks.proxyConfigFromPool.mockImplementation((pool) => ({
      proxyPoolId: pool.id,
      connectionProxyEnabled: true,
      connectionProxyUrl: pool.proxyUrl,
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    }));
  });

  it("adds proxy alternates for opencode", async () => {
    const credentials = await getProviderCredentials("opencode");

    expect(mocks.getProxyPools).toHaveBeenCalledOnce();
    expect(credentials.providerSpecificData.connectionProxyAlternates).toEqual([
      {
        proxyPoolId: "pool-b",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://b.example:8080",
        connectionNoProxy: "",
        vercelRelayUrl: "",
        strictProxy: false,
      },
    ]);
  });

  it("resolves the oc alias to the opencode path", async () => {
    const credentials = await getProviderCredentials("oc");

    expect(mocks.getProxyPools).toHaveBeenCalledOnce();
    expect(credentials.providerSpecificData.connectionProxyAlternates).toHaveLength(1);
  });

  it("keeps other free providers free of opencode proxy alternates", async () => {
    const credentials = await getProviderCredentials("mimo-free");

    expect(mocks.getProxyPools).not.toHaveBeenCalled();
    expect(credentials.providerSpecificData).not.toHaveProperty("connectionProxyAlternates");
    expect(credentials.providerSpecificData.connectionProxyPoolId).toBe("pool-b");
  });

  it("keeps pool rotation for other free providers without adding alternates", async () => {
    const credentials = await getProviderCredentials("free-rotating");

    expect(mocks.getProxyPools).toHaveBeenCalledOnce();
    expect(mocks.pickProxyPoolId).toHaveBeenCalledWith(["pool-a", "pool-b"], "round-robin", "free-rotating");
    expect(credentials.providerSpecificData).not.toHaveProperty("connectionProxyAlternates");
  });
});
