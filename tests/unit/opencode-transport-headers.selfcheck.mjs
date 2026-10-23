/**
 * Self-check for opencode transport headers. Run: node tests/unit/opencode-transport-headers.selfcheck.mjs
 */
import assert from "node:assert/strict";
import {
  deriveProjectId,
  buildTraceHeaders,
  applyOpencodeTransportHeaders,
} from "../../open-sse/executors/opencodeTransportHeaders.js";

// 同一身份稳定派生，不同身份互相隔离
const a1 = deriveProjectId("ses_abc");
const a2 = deriveProjectId("ses_abc");
const b1 = deriveProjectId("ses_def");
assert.equal(a1, a2, "同一 session 必须得到同一 project（否则配额按项目统计会散）");
assert.notEqual(a1, b1, "不同 session 必须得到不同 project");
assert.match(a1, /^ocp_[0-9a-f]{24}$/, "project id 形状应为 ocp_ + 24 hex");

// 空身份不产生 project，避免所有匿名流量塌缩成一个项目
assert.equal(deriveProjectId(""), null);
assert.equal(deriveProjectId(null), null);
assert.equal(deriveProjectId("   "), null);

// trace 头每次请求都不同，且符合各自格式
const t1 = buildTraceHeaders();
const t2 = buildTraceHeaders();
assert.notEqual(t1.traceparent, t2.traceparent, "traceparent 必须每请求变化");
assert.match(t1.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
assert.match(t1.b3, /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);

// 下游显式传入的 project 优先，不被派生值覆盖
const downstream = applyOpencodeTransportHeaders(
  { "x-opencode-project": "global" },
  { rawHeaders: { "x-opencode-project": "client-supplied" }, identity: "ses_abc" }
);
assert.equal(downstream["x-opencode-project"], "client-supplied", "下游值必须优先");

// 下游没传时用派生值
const derived = applyOpencodeTransportHeaders(
  {},
  { rawHeaders: {}, identity: "ses_abc" }
);
assert.equal(derived["x-opencode-project"], a1);
assert.ok(derived.b3 && derived.traceparent, "trace 头必须无条件下发");

// 下游自带 trace 时保留，不覆盖
const kept = applyOpencodeTransportHeaders(
  {},
  { rawHeaders: { b3: "down-b3", traceparent: "down-tp" }, identity: "ses_abc" }
);
assert.equal(kept.b3, "down-b3");
assert.equal(kept.traceparent, "down-tp");

// 无身份且下游未传 project 时，不编造 project
const noIdentity = applyOpencodeTransportHeaders({}, { rawHeaders: {} });
assert.equal(noIdentity["x-opencode-project"], undefined, "无身份时不应编造 project");
assert.ok(noIdentity.b3, "trace 头仍应下发");

console.log("opencodeTransportHeaders self-check: PASS (7 asserts)");
