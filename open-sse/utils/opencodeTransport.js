import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { OPENCODE_TRANSPORT_CONFIG } from "../config/runtimeConfig.js";
import { normalizeString, resolveEffectiveProxyUrl } from "./proxyResolution.js";

const TRANSPORT_PATH = "/forward";
const SIDECAR = path.join("scripts", "opencode-transport.mjs");

let active = null;
let starting = null;
let retryAt = 0;

function available() {
  return OPENCODE_TRANSPORT_CONFIG.mode !== "off" && Date.now() >= retryAt;
}

function sidecarPath() {
  return normalizeString(process.env.OPENCODE_TRANSPORT_SCRIPT) || path.join(process.cwd(), SIDECAR);
}

function block(error) {
  retryAt = Date.now() + OPENCODE_TRANSPORT_CONFIG.failureBackoffMs;
  console.warn(`[OpenCodeTransport] ${error.message}`);
  stop();
}

function stop() {
  const child = active?.child;
  active = null;
  starting = null;
  if (child) {
    try { child.kill("SIGKILL"); } catch { }
  }
}

function start() {
  if (starting) return starting;
  retryAt = 0;
  starting = new Promise((resolve, reject) => {
    const token = randomBytes(24).toString("hex");
    const child = spawn(OPENCODE_TRANSPORT_CONFIG.bunBin, [sidecarPath()], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_TRANSPORT_TOKEN: token, OPENCODE_TRANSPORT_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("sidecar did not report ready")), OPENCODE_TRANSPORT_CONFIG.readyTimeoutMs);

    function finish(error, port) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        starting = null;
        try { child.kill("SIGKILL"); } catch { }
        block(error);
        reject(error);
        return;
      }
      active = { child, port, token };
      starting = null;
      resolve(active);
    }

    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY (\d+)/);
      if (match) finish(null, Number(match[1]));
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on("error", (error) => finish(new Error(`spawn failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`sidecar exited (${code ?? signal}) ${stderr}`.trim()));
      else if (active?.child === child) active = null;
    });
  });
  return starting;
}

async function ensure() {
  if (!available()) return null;
  if (active) return active;
  try {
    return await start();
  } catch {
    return null;
  }
}

function headerObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function" && !Array.isArray(headers)) {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

function forward(port, token, payload, signal, headerTimeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let headerTimer = null;
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: TRANSPORT_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-transport-token": token,
      },
    }, (response) => {
      if (headerTimer) clearTimeout(headerTimer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
        else if (value != null) headers.set(key, value);
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 502,
        statusText: response.statusMessage || "",
        headers,
      }));
    });
    request.on("error", (error) => {
      if (headerTimer) clearTimeout(headerTimer);
      reject(error);
    });
    if (headerTimeoutMs > 0) {
      headerTimer = setTimeout(() => {
        const timeout = new Error(`upstream header timeout (${headerTimeoutMs}ms)`);
        timeout.transportTimeout = true;
        request.destroy(timeout);
      }, headerTimeoutMs);
      headerTimer.unref?.();
    }
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
    }
    request.end(body);
  });
}

export async function fetchViaTransport(url, options = {}, proxyOptions = null) {
  if (!available()) return null;
  if (normalizeString(proxyOptions?.vercelRelayUrl)) return null;
  if (typeof options.body !== "string" || !options.body) return null;

  const target = typeof url === "string" ? url : url.toString();
  const { url: proxyUrl } = resolveEffectiveProxyUrl(target, proxyOptions);
  if (proxyUrl && !/^https?:\/\//i.test(proxyUrl)) return null;
  const streamBody = typeof options.body === "string" && /"stream"\s*:\s*true/.test(options.body);
  const headerTimeoutMs = streamBody ? OPENCODE_TRANSPORT_CONFIG.headerTimeoutMs : 0;

  // A sidecar whose upstream fetch failed may hold a stale pooled socket or a
  // proxy that just reset. Restarting Bun is cheap and clears both; retry the
  // same payload once before declaring the transport unavailable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = await ensure();
    if (!transport) return null;

    try {
      const response = await forward(transport.port, transport.token, {
        url: target,
        method: options.method || "POST",
        headers: headerObject(options.headers),
        body: options.body,
        proxy: proxyUrl || null,
      }, options.signal, headerTimeoutMs);
      if (response.headers.get("x-transport-error") === "1") {
        const detail = await response.text().catch(() => "");
        console.warn(
          `[OpenCodeTransport] upstream fetch failed (attempt ${attempt + 1}/2): ${detail.slice(0, 300)}`
        );
        if (attempt === 0) {
          stop();
          continue;
        }
        return null;
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError") return null;
      // 响应头超时 = 出口路径死了（sidecar 本身活着）。不重启 sidecar 再试一次
      // （同一代理必然再挂），直接交给上层换另一条出口，把 60s 白等压到 20s。
      if (error.transportTimeout) {
        console.warn(`[OpenCodeTransport] ${error.message}; skipping sidecar restart, upstream failover owns the retry`);
        return null;
      }
      console.warn(`[OpenCodeTransport] forward failed (attempt ${attempt + 1}/2): ${error.message}`);
      if (attempt === 0) {
        stop();
        continue;
      }
      return null;
    }
  }
  return null;
}

const EXIT_HOOK = Symbol.for("ninerouter.opencodeTransport.exitHook");
if (!globalThis[EXIT_HOOK]) {
  globalThis[EXIT_HOOK] = true;
  process.once("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stop();
      process.exit(0);
    });
  }
}

export function resetTransport() {
  stop();
  retryAt = 0;
}
