// undici dispatcher 的失效范围：精确清一个端口时，另一个端口缓存的
// ProxyAgent 必须原样保留（否则又变回「一次失败全池重建」）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  return { fetchMock };
});

vi.mock("../../open-sse/utils/asipRotate.js", () => ({
  rotateEgress: vi.fn(),
  asipRotationEnabled: () => false,
  asipEgressForPort: async () => ({ egress: null, since: null }),
  markAsipProxyCooling: () => {},
  resetAsipRotateState: () => {},
}));

const { proxyAwareFetch, clearProxyDispatchers } = await import(
  "../../open-sse/utils/proxyFetch.js"
);

const P0 = "http://127.0.0.1:7890";
const P3 = "http://127.0.0.1:7893";
const TARGET = "https://api.openai.com/v1/chat/completions";
const po = (url) => ({
  url, enabled: true, connectionProxyUrl: url,
  connectionProxyEnabled: true, strictProxy: false,
});

beforeEach(() => {
  h.fetchMock.mockReset();
  h.fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
});

function lastDispatcher() {
  return h.fetchMock.mock.calls.at(-1)[1].dispatcher;
}

describe("clearProxyDispatchers scope", () => {
  it("drops only the requested port's cached agent", async () => {
    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P0));
    const d0 = lastDispatcher();
    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P3));
    const d3 = lastDispatcher();

    clearProxyDispatchers(P0);

    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P0));
    expect(lastDispatcher(), "本端口必须换一个新的 dispatcher").not.toBe(d0);
    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P3));
    expect(lastDispatcher(), "别的端口的 dispatcher 不该被丢").toBe(d3);
  });

  it("a no-arg call still clears everything (legacy rotate path)", async () => {
    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P0));
    const d0 = lastDispatcher();
    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P3));
    const d3 = lastDispatcher();

    clearProxyDispatchers();

    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P0));
    expect(lastDispatcher()).not.toBe(d0);
    await proxyAwareFetch(TARGET, { method: "POST", body: "{}" }, po(P3));
    expect(lastDispatcher()).not.toBe(d3);
  });
});
