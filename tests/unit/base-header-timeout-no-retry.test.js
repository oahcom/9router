import { describe, expect, it } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";

/**
 * 2026-10-28：9router1 的连接每条请求稳定烧 235s。预算由 base.js 的 60s 连接
 * 计时器乘以 502 重试（attempts:3）构成：首次 + 3 次重试 = 4×60s，再加 3 次
 * 3s 退避。对端在 60s 内连响应头都不给时，重试同一个 URL 只是再等一遍，
 * 所以改成"直接换 fallback URL，没有就抛"。
 *
 * 用 config.timeoutMs 把 60s 压到 120ms，让这条断言跑在毫秒级。
 */
class HangingExecutor extends BaseExecutor {
  constructor() {
    super("hang-test", { baseUrl: "http://hang.invalid/v1", timeoutMs: 120 });
    this.calls = 0;
  }

  fetchUpstream(url, options) {
    this.calls += 1;
    return new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error("fetch connect timeout"), { name: "AbortError" }));
      if (options.signal?.aborted) return fail();
      options.signal?.addEventListener("abort", fail, { once: true });
    });
  }
}

const args = {
  model: "m",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: false,
  credentials: { apiKey: "k" },
  signal: null,
  log: null,
};

describe("BaseExecutor header timeout", () => {
  it("does not retry the same URL after a header timeout", async () => {
    const exec = new HangingExecutor();
    const started = Date.now();
    await expect(exec.execute(args)).rejects.toThrow();
    const elapsed = Date.now() - started;

    // 旧行为是 4 次 × timeout + 3 次 3s 退避，这里 120ms 超时下会 ≥ 9s、calls 为 4。
    expect(exec.calls).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it("still moves to the next fallback URL when one exists", async () => {
    const exec = new HangingExecutor();
    exec.config = { ...exec.config, baseUrls: ["http://hang.invalid/v1", "http://hang2.invalid/v1"] };
    const started = Date.now();
    await expect(exec.execute(args)).rejects.toThrow();
    const elapsed = Date.now() - started;

    // 两条 URL 各试一次；彼此不重试，所以是 2 次而不是 2×(1+3) 次。
    expect(exec.calls).toBe(2);
    expect(elapsed).toBeLessThan(2000);
  });
});
