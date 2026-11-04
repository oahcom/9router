import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getProviderConnections: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
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

// 备选出口机制已整个删除（单池布局下恒为空集，见 opencode-503-429-branch-map）。
// 这里只留「哪些 provider 会去读池子」的行为：opencode 走指定池，其他 free provider
// 按 rotateStrategy 轮换。
const POOLS = [
  { id: "pool-a", proxyUrl: "http://a.example:8080", isActive: true, testStatus: "active" },
  { id: "pool-b", proxyUrl: "http://b.example:8080", isActive: true, testStatus: "active" },
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
  });

  it("keeps other free providers off the opencode-only path", async () => {
    const credentials = await getProviderCredentials("mimo-free");

    expect(credentials.providerSpecificData.connectionProxyPoolId).toBe("pool-b");
  });

  it("keeps pool rotation for other free providers", async () => {
    const credentials = await getProviderCredentials("free-rotating");

    expect(mocks.getProxyPools).toHaveBeenCalledOnce();
    expect(mocks.pickProxyPoolId).toHaveBeenCalledWith(["pool-a", "pool-b"], "round-robin", "free-rotating");
    expect(credentials.providerSpecificData.connectionProxyPoolId).toBe("pool-a");
  });
});
