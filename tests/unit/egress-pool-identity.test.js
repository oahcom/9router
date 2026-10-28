// Pools that point at the same proxyUrl are one physical egress.
//
// 2026-10-27: three active pools in the live DB all carried
// `http://127.0.0.1:7890` (the single sing-box mixed listener). `auth.js`
// builds `connectionProxyAlternates` by excluding the *picked pool id*, so the
// other two entered the list. `identifyFixedEgress` hashes `proxyUrl`, so all
// three produced `proxy:f1410cd719dcee161d171a3729c50bff`, and
// `selectAlternateProxy` skipped every candidate whose id was already excluded
// — the alternate set was always empty.
//
// That empty set is CORRECT: switching between those pools changes nothing
// upstream. The bug was never "candidates collided"; it was that a fourth pool
// on `127.0.0.1:7000` (unique url → unique id → only surviving candidate) kept
// being chosen as the alternate: 1618 switches between 15:28 and 17:27, all to
// a dead port. Deleting that pool made the switch path log nothing at all,
// which read the same as "switched and failed".
//
// So the contract these tests pin is:
//   - same proxyUrl  → never an alternate (there is nothing to switch to)
//   - different url  → still an alternate (the switch is real)
//   - no alternate   → say so in the log, every time
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
  return { fetchMock: vi.fn() };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
  clearProxyDispatchers: vi.fn(),
  default: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  identifyFixedEgress,
  resetEgressState,
  selectAlternateProxy,
} from "../../open-sse/utils/egress.js";

const TARGET = "https://opencode.ai/inference/v1/chat/completions";
const MODEL = "nemotron-3-ultra-free";
const SINGBOX = "http://127.0.0.1:7890";

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

function rateLimited() {
  return new Response(JSON.stringify({
    type: "error",
    error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
  }), { status: 429, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  resetEgressState();
});

describe("same-url pools are one physical egress", () => {
  it("gives colliding pools the same identity", () => {
    // Identity is the url hash, not the pool id. Two pools in front of one
    // listener cannot be told apart upstream, so they must not look distinct.
    const ids = [
      identifyFixedEgress(TARGET, pool("a", SINGBOX)).id,
      identifyFixedEgress(TARGET, pool("b", SINGBOX)).id,
      identifyFixedEgress(TARGET, pool("c", SINGBOX)).id,
    ];
    expect(new Set(ids).size).toBe(1);
  });

  it("never offers a same-url pool as an alternate", () => {
    const current = pool("a", SINGBOX);
    const proxyOptions = {
      ...current,
      connectionProxyAlternates: [pool("b", SINGBOX), pool("c", SINGBOX)],
    };
    const excluded = new Set([identifyFixedEgress(TARGET, current).id]);
    expect(selectAlternateProxy(proxyOptions, TARGET, excluded).alternate).toBeNull();
  });

  it("still offers a pool on a different url", () => {
    const current = pool("a", SINGBOX);
    const proxyOptions = {
      ...current,
      connectionProxyAlternates: [pool("b", SINGBOX), pool("d", "http://127.0.0.1:7000")],
    };
    const excluded = new Set([identifyFixedEgress(TARGET, current).id]);
    const picked = selectAlternateProxy(proxyOptions, TARGET, excluded);
    expect(picked.alternate?.egress.proxyUrl).toBe("http://127.0.0.1:7000");
  });
});

describe("a 429 with no alternate is logged, not silent", () => {
  it("names the missing alternate instead of returning quietly", async () => {
    // Before this, a fixed proxy egress could not be cooled (markEgressCooling
    // returns null for kind==="proxy"), so both branches of the no-alternate
    // path stayed silent. Operators could not distinguish "no candidate exists"
    // from "switched and failed" — and the same-url pool layout guarantees the
    // former forever.
    const executor = getExecutor("opencode");
    const current = pool("a", SINGBOX);
    const proxyOptions = {
      ...current,
      connectionProxyAlternates: [pool("b", SINGBOX), pool("c", SINGBOX)],
    };
    const warn = vi.fn();
    fetchMock.mockResolvedValueOnce(rateLimited());

    await executor.execute({
      model: MODEL,
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { rawHeaders: {} },
      proxyOptions,
      log: { warn, info: vi.fn(), debug: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const messages = warn.mock.calls.map(([, text]) => String(text));
    expect(messages.join("\n")).toMatch(/no alternate egress/);
    expect(messages.join("\n")).toMatch(/2 configured/);
  });
});
