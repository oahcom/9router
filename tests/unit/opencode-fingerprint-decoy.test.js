import { describe, it, expect } from "vitest";
import { applyFingerprintTools, restoreToolNames } from "open-sse/utils/opencodeFingerprint.js";

// Regression tests for the decoy-interception path: when the free-tier gate
// appends fake `shell`/`read` tools, the upstream model may call `shell` (or
// hallucinate `Bash`); the response side rewrites that to the caller's real
// command tool (codex: exec_command) and translates command->cmd.
const DECOY = "\u0000decoy";

function codexBody() {
  return {
    instructions: "",
    tools: [
      { type: "function", name: "exec_command", description: "Runs a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
      { type: "function", name: "foo", description: "unrelated", parameters: { type: "object", properties: { command: { type: "string" } } } },
    ],
  };
}

describe("opencodeFingerprint — decoy interception", () => {
  it("stores the caller command tool as a Map entry that survives new Map([...])", () => {
    const map = applyFingerprintTools(codexBody(), true);
    const sentinel = map.get(DECOY);
    expect(sentinel).toBeTruthy();
    expect(JSON.parse(sentinel)).toMatchObject({ targetName: "exec_command", argKey: "cmd" });
    const rebuilt = new Map([...map]);
    expect(JSON.parse(rebuilt.get(DECOY)).targetName).toBe("exec_command");
  });

  it("rewrites a decoy `shell` item to exec_command and command->cmd", () => {
    const map = applyFingerprintTools(codexBody(), true);
    const out = restoreToolNames(
      { item: { type: "function_call", id: "call_dec", name: "shell", arguments: '{"command":"ls"}' } },
      map,
    );
    expect(out.item.name).toBe("exec_command");
    expect(out.item.arguments).toBe('{"cmd":"ls"}');
  });

  it("rewrites hallucinated `Bash` items to exec_command", () => {
    const map = applyFingerprintTools(codexBody(), true);
    const out = restoreToolNames(
      { item: { type: "function_call", id: "call_b", name: "Bash", arguments: '{"command":"pwd"}' } },
      map,
    );
    expect(out.item.name).toBe("exec_command");
    expect(out.item.arguments).toBe('{"cmd":"pwd"}');
  });

  it("rewrites decoy argument deltas only when correlated by item_id", () => {
    const map = applyFingerprintTools(codexBody(), true);
    // Register the decoy item id via its output_item first.
    restoreToolNames({ item: { type: "function_call", id: "call_dec", name: "shell", arguments: "" } }, map);
    const hit = restoreToolNames(
      { type: "response.function_call_arguments.delta", item_id: "call_dec", delta: '{"command":' },
      map,
    );
    expect(hit.delta).toBe('{"cmd":');
  });

  it("does NOT corrupt a non-decoy tool that also uses a `command` field", () => {
    const map = applyFingerprintTools(codexBody(), true);
    const aliasFoo = [...map.entries()].find(([, original]) => original === "foo")[0];
    // Register the foo call (restored name, not decoy) so its item_id is known but NOT a decoy id.
    const added = restoreToolNames(
      { item: { type: "function_call", id: "call_foo", name: aliasFoo, arguments: "" } },
      map,
    );
    expect(added.item.name).toBe("foo");
    const delta = restoreToolNames(
      { type: "response.function_call_arguments.delta", item_id: "call_foo", delta: '{"command":' },
      map,
    );
    expect(delta.delta).toBe('{"command":');
    const full = restoreToolNames(
      { item: { type: "function_call", id: "call_foo", name: aliasFoo, arguments: '{"command":"x"}' } },
      map,
    );
    expect(full.item.name).toBe("foo");
    expect(full.item.arguments).toBe('{"command":"x"}');
  });

  it("does not install decoy metadata when the caller already declares shell", () => {
    const body = {
      instructions: "",
      tools: [
        { type: "function", name: "shell", description: "caller shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
        { type: "function", name: "exec_command", description: "Runs a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      ],
    };
    const map = applyFingerprintTools(body, true);
    expect(map.get(DECOY)).toBeUndefined();
    const out = restoreToolNames(
      { item: { type: "function_call", id: "s1", name: "shell", arguments: '{"command":"echo hi"}' } },
      map,
    );
    expect(out.item.name).toBe("shell");
    expect(out.item.arguments).toBe('{"command":"echo hi"}');
  });
});
