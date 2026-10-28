import { describe, expect, it } from "vitest";

import { canonicalProxyKey } from "../../open-sse/utils/proxyResolution.js";
import { identifyFixedEgress, selectAlternateProxy } from "../../open-sse/utils/egress.js";

const TARGET = "https://opencode.ai/inference/v1/chat/completions";

function pool(url) {
  return {
    proxyPoolId: null,
    connectionProxyEnabled: true,
    connectionProxyUrl: url,
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

describe("proxy egress identity", () => {
  it("treats spellings of one downstream as one exit", () => {
    const bare = identifyFixedEgress(TARGET, pool("http://127.0.0.1:7890"));
    const slash = identifyFixedEgress(TARGET, pool("http://127.0.0.1:7890/"));
    const upper = identifyFixedEgress(TARGET, pool("HTTP://127.0.0.1:7890"));
    expect(slash.id).toBe(bare.id);
    expect(upper.id).toBe(bare.id);
  });

  it("fills in default ports so a bare host and :443 agree", () => {
    expect(canonicalProxyKey("https://proxy.example")).toBe(canonicalProxyKey("https://proxy.example:443"));
    expect(canonicalProxyKey("http://proxy.example")).toBe(canonicalProxyKey("http://proxy.example:80/"));
  });

  it("drops credentials: the exit is the host, not the login", () => {
    expect(canonicalProxyKey("http://user:pass@proxy.example:8080")).toBe(canonicalProxyKey("http://proxy.example:8080"));
  });

  it("folds socks5h into socks5 but keeps http and socks apart", () => {
    expect(canonicalProxyKey("socks5h://127.0.0.1:1080")).toBe(canonicalProxyKey("socks5://127.0.0.1:1080"));
    expect(canonicalProxyKey("http://127.0.0.1:7890")).not.toBe(canonicalProxyKey("socks5://127.0.0.1:7890"));
  });

  it("keeps hosts and ports that really differ apart", () => {
    expect(canonicalProxyKey("http://127.0.0.1:7890")).not.toBe(canonicalProxyKey("http://127.0.0.1:7891"));
    expect(canonicalProxyKey("http://127.0.0.1:7890")).not.toBe(canonicalProxyKey("http://127.0.0.2:7890"));
  });

  it("does not report an alternate that is the same downstream respelled", () => {
    const primary = pool("http://127.0.0.1:7890");
    const respelled = { ...pool("http://127.0.0.1:7890/"), proxyPoolId: "respelled" };
    const current = identifyFixedEgress(TARGET, primary);
    const same = selectAlternateProxy(
      { ...primary, connectionProxyAlternates: [respelled] },
      TARGET,
      new Set([current.id])
    );
    expect(same.alternate).toBeNull();

    const real = { ...pool("http://127.0.0.1:7891"), proxyPoolId: "real" };
    const other = selectAlternateProxy(
      { ...primary, connectionProxyAlternates: [real] },
      TARGET,
      new Set([current.id])
    );
    expect(other.alternate?.egress.proxyUrl).toContain("7891");
  });
});
