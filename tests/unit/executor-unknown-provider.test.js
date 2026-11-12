// Regression guard for getExecutor's silent fallback.
//
// Before the guard, ANY unknown id reached DefaultExecutor, and default.js:95
// (`PROVIDERS[provider] || PROVIDERS.openai`) borrowed the openai transport.
// A typo such as "opencode_zen" therefore shipped the request — and the
// opencode credentials — to https://api.openai.com/v1/chat/completions while
// bypassing OpenCodeExecutor's client fingerprinting. Nothing logged a warning.
import { describe, it, expect, afterEach, vi } from "vitest";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

afterEach(() => {
  delete process.env.EXECUTOR_UNKNOWN_PROVIDER;
  vi.restoreAllMocks();
});

describe("getExecutor rejects unknown providers", () => {
  it("throws for an underscore/hyphen typo", () => {
    expect(() => getExecutor("opencode_zen")).toThrow(/unknown provider/);
  });

  it("throws for an id present in no registry", () => {
    expect(() => getExecutor("__nope__")).toThrow(/unknown provider/);
  });

  it("quotes the offending value so the caller can see the typo", () => {
    expect(() => getExecutor("opencode_zen")).toThrow(/opencode_zen/);
  });

  it("points at the escape hatch instead of failing silently", () => {
    expect(() => getExecutor("__nope__")).toThrow(/EXECUTOR_UNKNOWN_PROVIDER/);
  });
});

describe("getExecutor tolerates case and surrounding whitespace", () => {
  it("resolves OpenCode-Zen to the zen executor", () => {
    expect(getExecutor("OpenCode-Zen")).toBeInstanceOf(OpenCodeZenExecutor);
  });

  it("resolves a padded id", () => {
    expect(getExecutor("  opencode  ")).toBeInstanceOf(OpenCodeExecutor);
  });

  it("hasSpecializedExecutor agrees with getExecutor", () => {
    expect(hasSpecializedExecutor("OpenCode-Zen")).toBe(true);
    expect(hasSpecializedExecutor("opencode_zen")).toBe(false);
  });
});

describe("legitimate DefaultExecutor paths are untouched", () => {
  it("openai uses its own transport config", () => {
    const e = getExecutor("openai");
    expect(e).toBeInstanceOf(DefaultExecutor);
    expect(e.config).toBe(PROVIDERS.openai);
  });

  it("anthropic does not borrow openai's transport", () => {
    const e = getExecutor("anthropic");
    expect(e).toBeInstanceOf(DefaultExecutor);
    expect(e.config).toBe(PROVIDERS.anthropic);
    expect(e.getBaseUrls()[0]).toContain("api.anthropic.com");
  });

  it("compat providers keep working (real base url comes from credentials)", () => {
    const id = "openai-compatible-chat-00000000-0000-0000-0000-000000000000";
    const e = getExecutor(id);
    expect(e).toBeInstanceOf(DefaultExecutor);
    // 借用 openai 配置是预期行为：base.js buildUrl 会从
    // credentials.providerSpecificData.baseUrl 取真实地址。
    expect(e.config).toBe(PROVIDERS.openai);
  });

  it("caches one instance per id", () => {
    expect(getExecutor("openai")).toBe(getExecutor("openai"));
  });
});

describe("escape hatch", () => {
  it("EXECUTOR_UNKNOWN_PROVIDER=warn restores the old fallback and warns", () => {
    process.env.EXECUTOR_UNKNOWN_PROVIDER = "warn";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = getExecutor("__warn_mode_typo__");
    expect(e).toBeInstanceOf(DefaultExecutor);
    expect(e.config).toBe(PROVIDERS.openai); // 即旧行为
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("unknown ids are still rejected after the env var is cleared", () => {
    process.env.EXECUTOR_UNKNOWN_PROVIDER = "warn";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => getExecutor("__another_typo__")).not.toThrow();
    delete process.env.EXECUTOR_UNKNOWN_PROVIDER;
    expect(() => getExecutor("__third_typo__")).toThrow(/unknown provider/);
  });
});

describe("allowUnknown escape for adapter-driven providers", () => {
  // Image providers build their own URL/headers in imageProviders/*; they only
  // borrow DefaultExecutor's noAuth / refreshCredentials. Their ids are never in
  // PROVIDERS, so the strict check must be skippable — but only explicitly.
  it("accepts an image provider when the caller opts in", () => {
    expect(getExecutor("sdwebui", { allowUnknown: true })).toBeInstanceOf(DefaultExecutor);
    expect(getExecutor("huggingface", { allowUnknown: true })).toBeInstanceOf(DefaultExecutor);
  });

  it("still rejects the same id without the option", () => {
    expect(() => getExecutor("sdwebui")).toThrow(/unknown provider/);
  });
});

