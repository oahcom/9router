/**
 * OpenCode transport headers shared by the three opencode executors
 * (`opencode`, `opencode-go`, `opencode-zen`).
 *
 * The upstream CLI sends a stable per-conversation `x-opencode-project`, plus
 * W3C trace context (`b3`, `traceparent`) on every request. Without them the
 * gateways see the constant string "global" for every downstream and a missing
 * trace, which collapses per-project attribution and makes upstream-side
 * debugging impossible.
 *
 * `x-opencode-project` is derived *deterministically* from the downstream
 * identity rather than randomised per request: session-scoped quota is
 * accounted upstream, and minting fresh identities on every call burns through
 * it (see the note above `stableOpencodeSessions` in `opencode.js`). One
 * identity maps to one project, so a conversation keeps a stable attribution
 * while distinct downstreams stay isolated.
 *
 * Trace headers are per-request by definition; they carry no quota meaning.
 */

import crypto from "node:crypto";

const PROJECT_PREFIX = "ocp_";
const PROJECT_HEX_LEN = 24;

function lowerHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) out[k.toLowerCase()] = v;
  return out;
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Stable project id for a downstream identity. Callers pass whatever
 * identifies the conversation (session id, connection id, auth hash); the same
 * input always yields the same project.
 */
export function deriveProjectId(identity) {
  const material = String(identity ?? "").trim();
  if (!material) return null;
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-project\0${material}`)
    .digest("hex")
    .slice(0, PROJECT_HEX_LEN);
  return `${PROJECT_PREFIX}${digest}`;
}

/** W3C trace context: 16-byte trace id, 8-byte span id, sampled. */
export function buildTraceHeaders() {
  return {
    b3: `${randomHex(16)}-${randomHex(8)}-1-${randomHex(8)}`,
    traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
  };
}

/**
 * Apply project + trace headers in place.
 *
 * A value the downstream client actually sent wins over the derived one:
 * callers that already carry OpenCode-native headers are reproducing the real
 * client and must not be overwritten.
 */
export function applyOpencodeTransportHeaders(headers, { rawHeaders, identity, project } = {}) {
  if (!headers) return headers;
  const lower = lowerHeaders(rawHeaders);

  const downstreamProject = lower["x-opencode-project"];
  if (downstreamProject) {
    headers["x-opencode-project"] = downstreamProject;
  } else {
    const derived = project || deriveProjectId(identity);
    if (derived) headers["x-opencode-project"] = derived;
  }

  const trace = buildTraceHeaders();
  headers["b3"] = lower["b3"] || trace.b3;
  headers["traceparent"] = lower["traceparent"] || trace.traceparent;

  return headers;
}
