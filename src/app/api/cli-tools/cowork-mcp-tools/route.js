"use server";

import { NextResponse } from "next/server";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
// 显式 import：全局 fetch 补丁只在 proxyFetch 被求值过之后才生效，
// 本进程若没有别的模块先加载它，这里的裸 fetch 会原样跟随 30x（无跳复核）。
// 用 proxyAwareFetch 把逐跳闸门钉在本路由的求值路径上。
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { isLocalRequest } from "@/dashboardGuard";

const TIMEOUT_MS = 8000;

// 逐跳闸门：本路由可被远程调用，首跳的宽松判据（放行局域网）本身就是攻击面，
// 所以远程调用方每一跳都按全私有判据复核，而不是沿用首跳口径。
async function probeMcp(url, strict) {
  const hop = strict ? { strictRedirects: true } : {};
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // Step 1: initialize
    const initRes = await proxyAwareFetch(url, {
      ...hop,
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "9router", version: "1" } },
      }),
      signal: ac.signal,
    });
    if (initRes.status === 401 || initRes.status === 403) {
      return { requiresAuth: true, tools: [] };
    }
    if (!initRes.ok) {
      return { error: `init ${initRes.status}`, tools: [] };
    }
    const sessionId = initRes.headers.get("mcp-session-id") || "";
    await initRes.text().catch(() => {});

    const listHeaders = { ...headers };
    if (sessionId) listHeaders["mcp-session-id"] = sessionId;

    // Step 2: notifications/initialized (required by spec before tools/list)
    await proxyAwareFetch(url, {
      ...hop,
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      signal: ac.signal,
    }).catch(() => {});

    // Step 3: tools/list
    const listRes = await proxyAwareFetch(url, {
      ...hop,
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: ac.signal,
    });
    if (listRes.status === 401 || listRes.status === 403) {
      return { requiresAuth: true, tools: [] };
    }
    const ct = listRes.headers.get("content-type") || "";
    let parsed;
    if (ct.includes("text/event-stream")) {
      // Parse SSE: each "data: {...}" line is a JSON-RPC message
      const text = await listRes.text();
      const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
      for (const line of dataLines) {
        try {
          const obj = JSON.parse(line.replace(/^data:\s*/, ""));
          if (obj?.id === 2 && obj.result) { parsed = obj; break; }
        } catch { /* skip */ }
      }
    } else {
      parsed = await listRes.json().catch(() => null);
    }
    const tools = parsed?.result?.tools || [];
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description || "" })),
    };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message, tools: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }
    // SSRF guard for remote callers; local host keeps self-hosted MCP servers.
    // 必须用 Resolved 版：同步版只看 hostname 字面量，`http://169.254.169.254.nip.io/`
    // 一个字都不匹配 → 放行探针直接读到元数据。
    const isLocal = isLocalRequest(request);
    if (!isLocal) {
      try {
        await assertPublicUrlResolved(url);
      } catch {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }
    const result = await probeMcp(url, !isLocal);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e.message, tools: [] }, { status: 500 });
  }
}
