import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.EGRESS_PROBE_MODE = "off";
  process.env.OPENCODE_TRANSPORT = "off";
});
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  OPENCODE_FINGERPRINT_TOOLS,
  restoreToolNames,
  takeRenamedToolNames,
} from "../../open-sse/utils/opencodeFingerprint.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "" } })),
}));

// Break caught: opencode/muse-spark-1.3-contributor-free 400 vì upstream
// chỉ nhận tool_choice "auto"; named/required/none phải demote sang "auto".
const FREE_13 = "muse-spark-1.3-contributor-free";
const CREDS = { connectionId: "opencode-free-tool-choice-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
const TOOLS = [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: {} } }];
// Free-tier gate: caller tools are renamed to a stable neutral alias
// (fn_<7 base36 chars of a name hash>, see neutralizeCallerToolNames), then the
// fingerprint read/shell definitions are appended under their original names or
// upstream answers 403 FreeTierError. Assert the alias contract, never a hash.
const ALIAS = /^fn_[0-9a-z]{7}$/;
const WIRE_TOOLS = [
  ...TOOLS.map((tool) => ({ ...tool, name: expect.stringMatching(ALIAS) })),
  ...OPENCODE_FINGERPRINT_TOOLS.map((name) => expect.objectContaining({ type: "function", name })),
];

function responsesBody(model, tool_choice) {
  const body = { model, input: structuredClone(INPUT), tools: structuredClone(TOOLS) };
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  return body;
}

describe("opencode Free 1.3 tool_choice auto-only", () => {
  it("khai quirk đúng model 1.3-Free trong registry", () => {
    expect(PROVIDERS.opencode.quirks?.forceAutoToolChoiceModels).toEqual([FREE_13]);
  });

  it.each([
    ["Responses named", { type: "function", name: "get_weather" }],
    ["Chat function named", { type: "function", function: { name: "get_weather" } }],
    ["Claude tool named", { type: "tool", name: "get_weather" }],
    ["required", "required"],
    ["none", "none"],
  ])("demote %s sang auto (plain và max)", (_label, choice) => {
    const aliases = [];
    for (const model of [FREE_13, `${FREE_13}(max)`]) {
      const body = responsesBody(model, structuredClone(choice));
      const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
      expect(out.tool_choice).toBe("auto");
      expect(out.tools).toEqual(WIRE_TOOLS);
      expect(out.input).toEqual(INPUT);
      aliases.push(out.tools[0].name);
    }
    // Cùng tên caller -> cùng alias ở mọi lượt (hash theo tên, không theo vị trí).
    expect(aliases[0]).toBe(aliases[1]);
  });

  it("giữ auto và absent; tools/input nguyên vẹn", () => {
    const autoOut = new OpenCodeExecutor().transformRequest(
      FREE_13, responsesBody(FREE_13, "auto"), true, CREDS,
    );
    expect(autoOut.tool_choice).toBe("auto");
    expect(autoOut.tools).toEqual(WIRE_TOOLS);
    expect(autoOut.input).toEqual(INPUT);

    const absentOut = new OpenCodeExecutor().transformRequest(
      FREE_13, responsesBody(FREE_13, undefined), true, CREDS,
    );
    // Fingerprint pass fills an absent choice with "auto" (the API default once tools exist).
    expect(absentOut.tool_choice).toBe("auto");
    expect(absentOut.tools).toEqual(WIRE_TOOLS);
    expect(absentOut.input).toEqual(INPUT);
  });

  it.each([
    ["1.2-Free", "muse-spark-1.2-contributor-free"],
    ["future 1.4-Free", "muse-spark-1.4-contributor-free"],
    ["Go id", "muse-spark-1.3-contributor"],
    ["non-Muse", "big-pickle"],
  ])("giữ tool_choice named (không demote) cho %s", (_label, model) => {
    const choice = { type: "function", name: "get_weather" };
    const body = responsesBody(model, structuredClone(choice));
    const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
    // Hợp đồng mới: ngoài 1.3-Free vẫn giữ choice dạng named (không demote sang
    // "auto"), nhưng tên được retarget sang alias neutral của chính caller tool —
    // nếu không, model sẽ gọi một cái tên không còn trên wire.
    expect(out.tool_choice).toEqual({ ...choice, name: expect.stringMatching(ALIAS) });
    // Chat lane mang tên trong function.name, Responses lane ở name.
    expect(out.tools.map((tool) => tool.name ?? tool.function?.name)).toEqual([
      out.tool_choice.name,
      ...OPENCODE_FINGERPRINT_TOOLS,
    ]);
  });

  it("wire: execute gửi choice auto tới /inference/v1/responses", async () => {
    proxyAwareFetch.mockClear();
    const ex = new OpenCodeExecutor();
    const body = responsesBody(FREE_13, { type: "function", name: "get_weather" });
    const { url, transformedBody } = await ex.execute({
      model: FREE_13, body, stream: true, credentials: CREDS,
    });
    expect(url).toBe("https://opencode.ai/inference/v1/responses");
    expect(transformedBody.tool_choice).toBe("auto");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [actualUrl, actualInit] = proxyAwareFetch.mock.calls[0];
    expect(actualUrl).toBe("https://opencode.ai/inference/v1/responses");
    const sent = JSON.parse(actualInit.body);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.model).toBe(FREE_13);
    expect(sent.tools).toEqual(WIRE_TOOLS);
    expect(sent.input).toEqual(INPUT);

    // Đối xứng bắt buộc của hợp đồng alias: tên trên wire phải restore được về
    // tên caller gốc, còn read/shell giữ nguyên nên không nằm trong map.
    const map = takeRenamedToolNames(body);
    const alias = sent.tools.find((tool) => ALIAS.test(tool.name))?.name;
    expect(alias).toMatch(ALIAS);
    expect(map.get(alias)).toBe("get_weather");
    expect(map.has("read")).toBe(false);
    const restored = restoreToolNames(
      { output: [{ type: "function_call", name: alias, arguments: "{}" }] },
      map,
    );
    expect(restored.output[0].name).toBe("get_weather");
    const untouched = restoreToolNames(
      { output: [{ type: "function_call", name: "read", arguments: "{}" }] },
      map,
    );
    expect(untouched.output[0].name).toBe("read");
  });
});
