/**
 * proxy-global.js — Three-layer monkey-patch for Node.js built-in HTTP/HTTPS/HTTP2:
 * 
 * Layer 1: Agent proxy routing — https.globalAgent + http.globalAgent
 *   → CONNECT tunnel → sing-box:7890
 * 
 * Layer 2: Retry with bad-node tracking + local NO_PROXY
 *   → 429/5xx + exponential backoff + .bad_nodes.json shared state
 *   → local addresses bypass proxy entirely
 * 
 * Layer 3: BYPASS mode
 *   → sing-box unreachable → proxyEnabled = false (direct) + auto-recovery
 * 
 * Load via: NODE_OPTIONS="--require=/home/administrator/.9router/proxy-global.js"
 *
 * 开关控制:
 *   环境变量 PROXY_GLOBAL_DISABLED=1 → 跳过所有 monkey-patch
 *   或创建文件 ~/.9router/proxy-global.disabled → 同样跳过
 *   systemctl --user set-environment PROXY_GLOBAL_DISABLED=1  (临时)
 *   systemctl --user unset-environment PROXY_GLOBAL_DISABLED   (恢复)
 */

// ─── 开关检查 ──────────────────────────────────────────────────────────
const _disabledFile = require('path').join(
  require('os').homedir(), '.9router', 'proxy-global.disabled'
);
if (process.env.PROXY_GLOBAL_DISABLED === '1' || require('fs').existsSync(_disabledFile)) {
  console.log('[proxy-global] DISABLED — all monkey-patching skipped');
  return; // 不执行任何 patch，直接退出
}

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.9router');

// ─── Config from SQLite settings ───────────────────────────────────────
let proxyUrl = 'http://127.0.0.1:7890';
let proxyEnabled = false;
try {
  const DB_PATH = path.join(DATA_DIR, 'db', 'data.sqlite');
  if (fs.existsSync(DB_PATH)) {
    // Use node:sqlite (built-in Node 22+) — better-sqlite3 may not be installed
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
    try {
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      if (row) {
        const s = JSON.parse(row.data);
        if (s.outboundProxyEnabled && s.outboundProxyUrl) {
          proxyUrl = s.outboundProxyUrl;
          proxyEnabled = true;
        }
      }
    } finally { db.close(); }
  }
} catch (e) {
  proxyUrl = process.env.OUTBOUND_PROXY_URL || 'http://127.0.0.1:7890';
}
proxyEnabled = proxyEnabled || !!process.env.OUTBOUND_PROXY_URL;
if (process.env.OUTBOUND_PROXY_URL) {
  proxyUrl = process.env.OUTBOUND_PROXY_URL;
}
// 验证 proxyUrl 有效，无效则回退
try { new URL(proxyUrl); } catch (e) { console.log(`[proxy-global] ⚠ invalid OUTBOUND_PROXY_URL "${proxyUrl}", falling back to 7890`); proxyUrl = 'http://127.0.0.1:7890'; proxyEnabled = false; }

const MAX_RETRIES = 10;
const RETRY_BODY_PATTERNS = [
  // OpenAI-compatible: {"error": {"type": "rate_limit", "message": "..."}}
  // Anthropic-compatible: {"type": "error", "error": {"type": "rate_limit_error"}}
  /resource.?exhausted/i, /rate.?limit/i, /too many requests/i,
  /freeUsageLimit/i, /insufficient_quota/i, /quota.?exceeded/i,
  /rate_limit_error/i,      // Anthropic specific
  /overloaded/i,            // Server overloaded
  /try again later/i,       // Generic retry signal
  /service_unavailable/i,   // Anthropic
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Node switch via Clash API ──────────────────────────────────────
// 空响应根因是 sing-box 节点网络不稳定（断流/重置），
// 同一节点重试3次没用，必须先切节点再重试。
const SINGBOX_CLASH_API = 'http://127.0.0.1:9090';
const SINGBOX_SECRET_FILE = path.join(os.homedir(), '.singbox_secret');
let _singboxSecret = '';
let _singboxSecretMtime = 0;
const _nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;

let _nodeCount = 56; // 冷启动 fallback=56，_initNodeCount 启动时更新，每次 triggerNodeSwitch 实时刷新
async function _initNodeCount() {
  try {
    const secret = await _readSingboxSecret();
    if (secret && _nativeFetch) {
      const r = await _nativeFetch(`${SINGBOX_CLASH_API}/proxies/proxy`, {
        headers: { 'Authorization': `Bearer ${secret}` },
        signal: AbortSignal.timeout(3000)
      });
      if (r.ok) {
        const data = await r.json();
        _nodeCount = (data.all || []).length;
        console.log(`[proxy-global] 初始化节点总数: ${_nodeCount}`);
      }
    }
  } catch (e) { console.log(`[proxy-global] ⚠ 初始化节点数失败: ${e.message}`); }
}
_initNodeCount();

function _readSingboxSecret() {
  try {
    if (fs.existsSync(SINGBOX_SECRET_FILE)) {
      const stat = fs.statSync(SINGBOX_SECRET_FILE);
      const mtime = stat.mtimeMs;
      // 权限安全检查：与 daemon config.py 对齐，只允许 600
      if (stat.mode & 0o077) { console.log(`[proxy-global] ⚠ Sing-box secret file has loose permissions (${(stat.mode & 0o777).toString(8)}), expected 600`); }
      if (_singboxSecret && mtime === _singboxSecretMtime) return _singboxSecret;
      _singboxSecret = fs.readFileSync(SINGBOX_SECRET_FILE, 'utf-8').trim();
      _singboxSecretMtime = mtime;
      if (!_singboxSecret) _singboxSecret = ''; // 空文件视为无 secret
    }
  } catch (e) { console.log(`[proxy-global] ⚠ Failed to read singbox secret: ${e.message}`); }
  return _singboxSecret;
}

let _switching = null; // Promise chain: concurrent callers await the ongoing switch

async function triggerNodeSwitch() {
  if (_switching) return _switching; // 并发调用者等待正在进行的切换而非直接失败
  const secret = _readSingboxSecret();
  if (!secret || !_nativeFetch) return false;
  const p = (async () => {
    try {
      const r = await _nativeFetch(`${SINGBOX_CLASH_API}/proxies/proxy`, {
        headers: { 'Authorization': `Bearer ${secret}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) return false;
      const data = await r.json();
      const current = data.now;
      _nodeCount = (data.all || []).length;
      const badNodes = loadBadNodes();
      const allNodes = (data.all || []).filter(n => n !== 'direct' && n !== current && !badNodes[n]);
      if (allNodes.length === 0) return false;
      const chosen = allNodes[Math.floor(Math.random() * allNodes.length)];
      const putRes = await _nativeFetch(`${SINGBOX_CLASH_API}/proxies/proxy`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: chosen }),
        signal: AbortSignal.timeout(5000)
      });
      if (!putRes.ok) { console.log(`[proxy-global] ⚠ PUT switch ${chosen} failed: ${putRes.status}`); return false; }
      console.log(`[proxy-global] 🔄 Node switch: ${current} → ${chosen}`);
      return true;
    } catch (e) {
      console.log(`[proxy-global] ⚠ Node switch failed: ${e.message}`);
      return false;
    }
  })();
  _switching = p;
  p.finally(() => { if (_switching === p) _switching = null; });
  return p;
}


// ─── NO_PROXY ──────────────────────────────────────────────────────────
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '0.0.0.0']);
function shouldUseProxy(host) {
  if (!host) return false;
  if (LOCAL_HOSTS.has(host)) return false;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host)) return false;
  if (/^\[/.test(host)) return false;
  return true;
}

// ─── Bad node tracking ────────────────────────────────────────────────
// TTL / 路径均可由 daemon 通过环境变量注入，避免配置漂移
const BAD_NODES_SHARED = path.join(DATA_DIR, '..', 'dkk-projects', 'auto-switch-ip', '.bad_nodes.json');
const BAD_NODES_LOCAL = path.join(DATA_DIR, 'bad_nodes.json');
const BAD_NODES_FILE = process.env.BAD_NODES_FILE_PATH || (fs.existsSync(path.dirname(BAD_NODES_SHARED)) ? BAD_NODES_SHARED : BAD_NODES_LOCAL);
const BAD_NODES_TTL = parseInt(process.env.BAD_NODES_TTL, 10) || 300;

let _bad_nodes_cache = null;
let _bad_nodes_mtime = 0;

function loadBadNodes() {
  try {
    if (!fs.existsSync(BAD_NODES_FILE)) { _bad_nodes_cache = {}; _bad_nodes_mtime = 0; return _bad_nodes_cache; }
    // TOCTOU 缓解：先 stat 检查 mtime，命中缓存则跳过读文件
    const cur = fs.statSync(BAD_NODES_FILE).mtimeMs;
    if (cur === _bad_nodes_mtime && _bad_nodes_cache !== null) return _bad_nodes_cache;
    const raw = fs.readFileSync(BAD_NODES_FILE, 'utf-8');
    // 读完后二次确认 mtime 未变（文件可能刚被 daemon 替换）
    const cur2 = fs.statSync(BAD_NODES_FILE).mtimeMs;
    const all = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    const fresh = {};
    for (const [k, v] of Object.entries(all)) {
      // daemon 写 {"expire": ts, "reason": str}，proxy-global 写纯数字 ts — 兼容两种
      const exp = (v !== null && typeof v === 'object' && 'expire' in v) ? v.expire : v;
      if (typeof exp === 'number' && exp > now) fresh[k] = exp;
    }
    _bad_nodes_cache = fresh;
    _bad_nodes_mtime = cur2;
    return fresh;
  } catch (e) { console.log('[proxy-global] ⚠️ Failed to load bad nodes:', e.message); _bad_nodes_cache = {}; return _bad_nodes_cache; }
}

function isBadNode(host, port) {
  const key = `${host}:${port}-any`;
  const all = loadBadNodes();
  return all[key] !== undefined && all[key] > Math.floor(Date.now() / 1000);
}

function _markBadEntry(key, reason) {
  // proxy-global.js 只读，由 daemon.py 独占写入 .bad_nodes.json
  // 防止双进程 read-modify-write 竞争导致条目丢失
  // daemon 的 _ban_node / cleanup_dead_ttl 负责所有写入
  console.log(`[proxy-global] markBadEntry ${key} (${reason}) — 写入由 daemon 管理，跳过`);
  return false;
}

function markBadSingboxNode(nodeTag) {
  return _markBadEntry(nodeTag, 'proxy-global');
}

function markBadNode(host, port) {
  return _markBadEntry(`${host}:${port}-any`, 'markBadNode');
}

// ─── BYPASS mode ──────────────────────────────────────────────────────
const BYPASS_THRESHOLD = 3;
const BYPASS_CHECK_INTERVAL = 10000;
let bypassMode = false;
let connectFailCount = 0;
let bypassHealthTimer = null;

function enterBypass() {
  if (bypassMode) return;
  bypassMode = true;
  proxyEnabled = false;
  console.log('[proxy-global] 🚫 BYPASS: sing-box unreachable, direct connections');
  if (!bypassHealthTimer) {
    bypassHealthTimer = setInterval(checkBypassHealth, BYPASS_CHECK_INTERVAL);
    bypassHealthTimer.unref();
  }
}

function exitBypass() {
  if (!bypassMode) return;
  bypassMode = false;
  proxyEnabled = true;
  connectFailCount = 0;
  console.log('[proxy-global] ✅ BYPASS cleared: sing-box recovered, proxy re-enabled');
  if (bypassHealthTimer) { clearInterval(bypassHealthTimer); bypassHealthTimer = null; }
}

async function checkBypassHealth() {
  try {
    const sock = net.connect('7890', '127.0.0.1');
    await Promise.race([
      new Promise((resolve, reject) => {
        sock.on('connect', () => { sock.destroy(); resolve(); });
        sock.on('error', reject);
      }),
      sleep(3000).then(() => { try { sock.destroy(); } catch (e) { console.log(`[proxy-global] ⚠ Socket destroy in bypass check: ${e.message}`); } throw new Error('timeout'); }),
    ]);
    exitBypass();
  } catch (e) { console.log(`[proxy-global] ⚠ Bypass health check failed: ${e.message}`); }
}

function recordProxyConnectResult(success) {
  if (success) {
    connectFailCount = Math.max(0, connectFailCount - 1);
    if (bypassMode) exitBypass();
  } else {
    if (bypassMode) return;
    connectFailCount++;
    if (connectFailCount >= BYPASS_THRESHOLD) enterBypass();
  }
}

// ─── Helper: TLS tunnel through CONNECT proxy ──────────────────────────
function tlsTunnel(targetHost, targetPort, alpn) {
  return new Promise((resolve, reject) => {
    const pUrl = new URL(proxyUrl);
    const sock = net.connect(pUrl.port || '7890', pUrl.hostname, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let settled = false;
    let buf = '';
    const handler = (c) => {
      if (settled) return;
      buf += c.toString();
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      settled = true;
      sock.removeListener('data', handler);
      const sl = buf.substring(0, idx).split('\r\n')[0];
      const code = parseInt(sl.split(' ')[1] || '0', 10);
      if (code >= 200 && code < 300) {
        recordProxyConnectResult(true);
        const ts = tls.connect({
          socket: sock, servername: targetHost, host: targetHost, port: targetPort,
          rejectUnauthorized: false, ...(alpn ? { ALPNProtocols: alpn } : {}),
        }, () => resolve(ts));
        ts.on('error', (e) => { recordProxyConnectResult(false); reject(e); });
      } else { sock.destroy(); recordProxyConnectResult(false); reject(new Error(`CONNECT ${sl}`)); }
    };
    sock.on('data', handler);
    sock.on('error', (err) => { if (!settled) { settled = true; recordProxyConnectResult(false); reject(err); } });
  });
}

function connectThroughProxy(targetHost, targetPort) {
  // Raw TCP CONNECT tunnel (no TLS) - for ProxyHttpsAgent and ProxyHttpAgent
  return new Promise((resolve, reject) => {
    const pUrl = new URL(proxyUrl);
    const sock = net.connect(pUrl.port || '7890', pUrl.hostname, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let settled = false;
    let buf = '';
    const handler = (c) => {
      if (settled) return;
      buf += c.toString();
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      settled = true;
      sock.removeListener('data', handler);
      const sl = buf.substring(0, idx).split('\r\n')[0];
      const code = parseInt(sl.split(' ')[1] || '0', 10);
      if (code >= 200 && code < 300) {
        recordProxyConnectResult(true);
        resolve(sock);
      } else { sock.destroy(); recordProxyConnectResult(false); reject(new Error(`CONNECT ${sl}`)); }
    };
    sock.on('data', handler);
    sock.on('error', (err) => { if (!settled) { settled = true; recordProxyConnectResult(false); reject(err); } });
  });
}

function tcpThroughProxy(targetHost, targetPort) {
  // Raw TCP CONNECT tunnel (no TLS) - for ProxyHttpAgent (plain HTTP)
  return connectThroughProxy(targetHost, targetPort);
}

// ─── Retry wrapper ────────────────────────────────────────────────────
function makeRetryableRequest(origFn, isHttps) {
  return function (urlOrOpts, options, callback) {
    let opts, cb;
    if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
      const u = typeof urlOrOpts === 'string' ? new URL(urlOrOpts) : urlOrOpts;
      opts = { hostname: u.hostname, port: parseInt(u.port, 10) || (isHttps ? 443 : 80), path: u.pathname + u.search };
      if (typeof options === 'object' && options !== null) Object.assign(opts, options);
      cb = typeof options === 'function' ? options : callback;
    } else {
      opts = Object.assign({}, urlOrOpts);
      cb = typeof options === 'function' ? options : callback;
    }
    delete opts.protocol;

    if (!proxyEnabled || !cb) return origFn(urlOrOpts, options, callback);
    if (typeof cb !== 'function') cb = null;

    const host = opts.hostname;
    const port = opts.port || (isHttps ? 443 : 80);
    const bodyChunks = [];
    const fakeReq = new EventEmitter();
    fakeReq.method = opts.method || 'GET';
    fakeReq.path = opts.path || '/';
    fakeReq.headers = opts.headers || {};
    fakeReq.writableEnded = false;
    fakeReq.writableFinished = false;
    fakeReq.destroyed = false;

    let currentAttemptReq = null;
    let _headersOnError = null;  // 捕获最后一次响应的 headers，用于 locked-502 路径
    if (cb) fakeReq.on('response', cb);

    fakeReq.write = function (chunk) {
      if (fakeReq.writableEnded) return false;
      if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    fakeReq.end = function (chunk) {
      if (fakeReq.writableEnded) return;
      fakeReq.writableEnded = true;
      fakeReq.writableFinished = true;
      if (chunk && typeof chunk !== 'function') fakeReq.write(chunk);

      const fullBody = Buffer.concat(bodyChunks);
      let attempt = 0;

      function doAttempt() {
        if (fakeReq.destroyed) return;
        attempt++;
        const agent = isHttps ? https.globalAgent : http.globalAgent;
        const attemptOpts = Object.assign({}, opts, { agent });

        try {
          const attemptReq = origFn(attemptOpts);
          currentAttemptReq = attemptReq;

          attemptReq.on('response', (res) => {             currentAttemptReq = null;
            if (fakeReq.destroyed) return;
            _headersOnError = res.headers;

            // 200 responses: check content-type for streaming (SSE), otherwise buffer and check errors
            if (res.statusCode >= 200 && res.statusCode < 300 && res.statusCode !== 429) {
              // 204 No Content / 304 Not Modified: empty body is valid
              if (res.statusCode === 204 || res.statusCode === 304) {
                fakeReq.emit('response', res);
                return;
              }
              const ct = (res.headers['content-type'] || '').toLowerCase();
              const isStreaming = ct.includes('stream') || ct.includes('event-stream') || ct.includes('text/event-stream');
              
              if (isStreaming) {
                // SSE streaming — pass through directly, don't buffer
                // But detect empty body or error events: retry on those
                let hasData = false;
                let firstChunk = null;
                let firstChunkChecked = false;
                let sseErrorDetected = false;
                const origOn = res.on.bind(res);
                res.on = function(ev, fn) {
                  if (ev === 'data') {
                    origOn('data', function(c) {
                      hasData = true;
                      // Check EVERY chunk for SSE error events (not just first)
                      if (_isSseChunkError(c)) {
                        sseErrorDetected = true;
                        if (attempt <= MAX_RETRIES) {
                          console.log('[proxy-global] SSE error chunk → node switch retry '+attempt+'/'+MAX_RETRIES+' ('+host+')');
                          try { res.socket && res.socket.destroy(); } catch (e) { console.log(`[proxy-global] ⚠ Socket destroy failed: ${e.message}`); }
                          triggerNodeSwitch().then(switched => {
                            if (switched) return doAttempt();
                            const fr = new PassThrough();
                            fr.statusCode = 502; fr.complete = true;
                            fr.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked',type:'proxy-global_error'}})));
                            fr.push(null);
                            fakeReq.emit('response', fr);
                          });
                          return;
                        }
                        console.log('[proxy-global] SSE error chunk, retries exhausted ('+host+')');
                        try { res.resume(); res.socket && res.socket.destroy(); } catch (e) { console.log(`[proxy-global] ⚠ Socket destroy failed: ${e.message}`); }
                        fakeReq.emit('error', new Error('Upstream returned error in SSE stream after '+MAX_RETRIES+' retries'));
                        return;
                      }
                      if (!firstChunkChecked) {
                        firstChunkChecked = true;
                        firstChunk = c;
                      }
                      fn(c);
                    });
                  } else if (ev === 'end') {
                    origOn('end', function() {
                      if (!hasData) {
                        // Empty SSE body: 切节点再重试，死磕同一节点没用
                        if (attempt <= MAX_RETRIES) {
                          console.log('[proxy-global] SSE empty → node switch retry '+attempt+'/'+MAX_RETRIES+' ('+host+')');
                          triggerNodeSwitch().then(switched => {
                      if (!switched) {
                        console.log('[proxy-global] Node switch locked → 502 ('+host+')');
                        const failRes = new PassThrough();
                        failRes.statusCode = 502;
                        failRes.headers = _headersOnError || {};
                        failRes.complete = true;
                        failRes.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked by concurrent retry',type:'proxy-global_error'}})));
                        failRes.push(null);
                        fakeReq.emit('response', failRes);
                        return;
                      }
                      return doAttempt();
                    });
                        } else {
                          console.log('[proxy-global] SSE empty body, retries exhausted ('+host+')');
                          try { res.socket && res.socket.destroy(); } catch (e) { console.log(`[proxy-global] ⚠ Socket destroy failed: ${e.message}`); }
                          fakeReq.emit('error', new Error('Upstream returned empty HTTP 200 (SSE) after '+MAX_RETRIES+' retries'));
                        }
                        return;
                      }
                      fn();
                    });
                  } else {
                    origOn(ev, fn);
                  }
                  return res;
                };
                fakeReq.emit('response', res);
                return;
              }
              
              const respChunks = [];
              res.on('data', c => respChunks.push(c));
              res.on('end', () => {
                if (fakeReq.destroyed) return;
                const bodyStr = Buffer.concat(respChunks).toString('utf8');
                if (bodyStr.length === 0) {
                  // Empty body: 切节点再重试，死磕同一节点没用
                  if (attempt <= MAX_RETRIES) {
                    console.log('[proxy-global] Empty 200 → node switch retry '+attempt+'/'+MAX_RETRIES+' ('+host+')');
                    triggerNodeSwitch().then(switched => {
                      if (!switched) {
                        console.log('[proxy-global] Node switch locked → 502 ('+host+')');
                        const failRes = new PassThrough();
                        failRes.statusCode = 502;
                        failRes.headers = _headersOnError || {};
                        failRes.complete = true;
                        failRes.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked by concurrent retry',type:'proxy-global_error'}})));
                        failRes.push(null);
                        fakeReq.emit('response', failRes);
                        return;
                      }
                      return doAttempt();
                    });
                  } else {
                    console.log('[proxy-global] Empty body retries exhausted ('+host+')');
                    const fakeRes = new PassThrough();
                    fakeRes.statusCode = 502;
                    fakeRes.headers = _headersOnError || res.headers;
                    fakeRes.complete = true;
                    fakeRes.push(Buffer.from(JSON.stringify({
                      error: { message: 'Upstream returned empty HTTP 200 after '+MAX_RETRIES+' node-switch retries', type: 'proxy-global_error' }
                    })));
                    fakeRes.push(null);
                    fakeReq.emit('response', fakeRes);
                  }
                  return;
                }
                if (attempt <= MAX_RETRIES && _shouldRetryFetch(res.statusCode, bodyStr)) {
                  if (isBadNode(host, port)) {
                    console.log('[proxy-global] skipping bad node');
                    const fakeRes = new PassThrough();
                    fakeRes.statusCode = res.statusCode;
                    fakeRes.headers = _headersOnError || res.headers;
                    fakeRes.complete = true;
                    fakeRes.push(Buffer.concat(respChunks)); fakeRes.push(null);
                    fakeReq.emit('response', fakeRes);
                    return;
                  }
                  console.log('[proxy-global] Retry '+attempt+'/'+MAX_RETRIES+' → node switch ('+host+' 200 error)');
                  triggerNodeSwitch().then(switched => {
                      if (!switched) {
                        console.log('[proxy-global] Node switch locked → 502 ('+host+')');
                        const failRes = new PassThrough();
                        failRes.statusCode = 502;
                        failRes.headers = _headersOnError || {};
                        failRes.complete = true;
                        failRes.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked by concurrent retry',type:'proxy-global_error'}})));
                        failRes.push(null);
                        fakeReq.emit('response', failRes);
                        return;
                      }
                      return doAttempt();
                    });
                } else {
                  const fakeRes = new PassThrough();
                  fakeRes.statusCode = res.statusCode;
                  fakeRes.headers = _headersOnError || res.headers;
                  fakeRes.complete = true;
                    fakeRes.push(Buffer.concat(respChunks)); fakeRes.push(null);
                    fakeReq.emit('response', fakeRes);
                    return;
                }
              });
            } else if (res.statusCode === 429 || res.statusCode >= 500) {
              // Retryable status: 429 rate limit / 5xx server error → node switch + retry
              const respChunks = [];
              res.on('data', c => respChunks.push(c));
              res.on('end', () => {
                if (fakeReq.destroyed) return;
                if (attempt <= MAX_RETRIES) {
                  console.log('[proxy-global] Retry '+attempt+'/'+MAX_RETRIES+' → node switch ('+host+' status='+res.statusCode+')');
                  triggerNodeSwitch().then(switched => {
                      if (!switched) {
                        console.log('[proxy-global] Node switch locked → 502 ('+host+')');
                        const failRes = new PassThrough();
                        failRes.statusCode = 502;
                        failRes.headers = _headersOnError || {};
                        failRes.complete = true;
                        failRes.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked by concurrent retry',type:'proxy-global_error'}})));
                        failRes.push(null);
                        fakeReq.emit('response', failRes);
                        return;
                      }
                      return doAttempt();
                    });
                } else {
                  const fakeRes = new PassThrough();
                  fakeRes.statusCode = res.statusCode;
                  fakeRes.headers = _headersOnError || res.headers;
                  fakeRes.complete = true;
                  fakeRes.push(Buffer.concat(respChunks)); fakeRes.push(null);
                  fakeReq.emit('response', fakeRes);
                }
              });
            } else {
              fakeReq.emit('response', res);
            }
          });

          if (fullBody.length > 0) attemptReq.write(fullBody);
          attemptReq.end();
          attemptReq.on('error', (err) => {
            currentAttemptReq = null;
            if (fakeReq.destroyed) return;
            if (attempt <= MAX_RETRIES) {
              console.log(`[proxy-global] ⚠️  Retry ${attempt}/${MAX_RETRIES} → node switch (${host} error: ${err.message})`);
              triggerNodeSwitch().then(switched => {
                      if (!switched) {
                        console.log('[proxy-global] Node switch locked → 502 ('+host+')');
                        const failRes = new PassThrough();
                        failRes.statusCode = 502;
                        failRes.headers = _headersOnError || {};
                        failRes.complete = true;
                        failRes.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked by concurrent retry',type:'proxy-global_error'}})));
                        failRes.push(null);
                        fakeReq.emit('response', failRes);
                        return;
                      }
                      return doAttempt();
                    });
            } else { fakeReq.emit('error', err); }
          });
        } catch (err) {
          currentAttemptReq = null;
          if (fakeReq.destroyed) return;
          if (attempt <= MAX_RETRIES) {
            console.log(`[proxy-global] ⚠️  Retry ${attempt}/${MAX_RETRIES} → node switch (${host} error: ${err.message})`);
            triggerNodeSwitch().then(switched => {
                      if (!switched) {
                        console.log('[proxy-global] Node switch locked → 502 ('+host+')');
                        const failRes = new PassThrough();
                        failRes.statusCode = 502;
                        failRes.headers = _headersOnError || {};
                        failRes.complete = true;
                        failRes.push(Buffer.from(JSON.stringify({error:{message:'Upstream error but node switch locked by concurrent retry',type:'proxy-global_error'}})));
                        failRes.push(null);
                        fakeReq.emit('response', failRes);
                        return;
                      }
                      return doAttempt();
                    });
          } else { fakeReq.emit('error', err); }
        }
      }
      doAttempt();
    };

    fakeReq.destroy = function () {
      fakeReq.destroyed = true;
      fakeReq.writableEnded = true;
      fakeReq.writableFinished = true;
      if (currentAttemptReq) { try { currentAttemptReq.destroy(); } catch (e) { console.log(`[proxy-global] ⚠ Attempt req destroy failed: ${e.message}`); } currentAttemptReq = null; }
    };
    fakeReq.abort = fakeReq.destroy;
    fakeReq.setHeader = () => {};
    fakeReq.getHeader = (k) => opts.headers?.[k];
    fakeReq.removeHeader = () => {};
    fakeReq.flushHeaders = () => {};
    fakeReq.setTimeout = () => {};
    fakeReq.setNoDelay = () => {};
    fakeReq.setSocketKeepAlive = () => {};
    fakeReq.cork = () => {};
    fakeReq.uncork = () => {};
    fakeReq.socket = null;
    fakeReq.connection = null;

    return fakeReq;
  };
}



// ─── Global fetch retry wrapper ──────────────────────────────────────
// Node.js global fetch() is NOT covered by makeRetryableRequest (which
// only monkey-patches https.request/http.request). 9router's API routes
// use fetch() for upstream AI provider calls, so we wrap fetch() with
// the same retry logic for empty/malformed 200 responses.
//
// This closes the acknowledged gap from bootstrap-undici.js:
//   "fetch() calls from API routes go directly."

const FETCH_RETRYABLE_STATUSES = new Set([429, 500, 501, 502, 503, 504]);
const SSE_PEEK_TIMEOUT_MS = 2000;

// SSE error detection: check if a raw SSE chunk contains an error event
// that should trigger retry instead of being passed to the SDK.
// Catches patterns like:
//   data: {"error": {"message": "Streaming response failed", "type": "..."}}
//   data: {"error": {"type": "rate_limit_error", "message": "..."}}
function _isSseChunkError(chunk) {
  if (!chunk) return false;
  try {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    // Quick pre-check before JSON parsing
    if (!text.includes('"error"')) return false;
    // Parse each SSE line
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        if (obj && typeof obj === 'object' && obj.error) {
          const errMsg = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
          // Retry on transient/limit/server errors, skip auth/bad-request
          if (/rate|limit|quota|exhausted|overload|retry|timeout|unavailable|server_error|upstream|connection|streaming response failed|empty response/i.test(errMsg)) {
            return true;
          }
        }
      } catch (e) { console.log(`[proxy-global] ⚠ SSE chunk parse error: ${e.message}`); }
    }
  } catch (e) { console.log(`[proxy-global] ⚠ SSE error detection failed: ${e.message}`); }
  return false;
}

async function _peekSseStream(body, timeoutMs) {
  const reader = body.getReader();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      reader.cancel().catch((e) => { console.log(`[proxy-global] ⚠ SSE reader cancel failed: ${e.message}`); });
      resolve({ hasData: false, firstChunk: null, restReader: null });
    }, timeoutMs);

    reader.read().then(({ done, value }) => {
      clearTimeout(timer);
      if (done || !value || value.byteLength === 0) {
        resolve({ hasData: false, firstChunk: null, restReader: null });
      } else {
        resolve({ hasData: true, firstChunk: value, restReader: reader });
      }
    }).catch((e) => {
      console.log(`[proxy-global] ⚠ SSE peek read failed: ${e.message}`);
      clearTimeout(timer);
      resolve({ hasData: false, firstChunk: null, restReader: null });
    });
  });
  return result;
}

function _reconstructStream(firstChunk, restReader) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunk);
      function pump() {
        restReader.read().then(({ done, value }) => {
          if (done) { controller.close(); return; }
          controller.enqueue(value);
          pump();
        }).catch(err => controller.error(err));
      }
      pump();
    }
  });
}

function _shouldRetryFetch(statusCode, bodyText) {
  if (FETCH_RETRYABLE_STATUSES.has(statusCode)) return true;
  if (!bodyText || typeof bodyText !== 'string') return false;
  if (RETRY_BODY_PATTERNS.some(p => p.test(bodyText))) return true;
  if (statusCode === 200) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && parsed.error) {
        const errMsg = String(parsed.error?.message || parsed.error?.type || parsed.error).toLowerCase();
        // 通用检测：任何 server/upstream/infra 层 error 都触发重试
        // 覆盖 OpenCode Free: {"error": {"type": "server_error", "message": "Error from provider (Console): Upstream request failed"}}
        if (/rate|limit|quota|exhausted|overload|retry|timeout|unavailable|server_error|upstream|connection|service_unavailable|streaming response failed|empty response/i.test(errMsg)) return true;
      }
    } catch (e) { console.log(`[proxy-global] ⚠ Retry body parse error: ${e.message}`); }
  }
  return false;
}

function makeRetryableFetch(origFetch) {
  return async function retryableFetch(url, init) {
    const urlStr = typeof url === 'string' ? url : (url instanceof Request ? url.url : String(url));
    const hasDispatcher = init && init.dispatcher;
    let attempt = 0;
    
    while (true) {
      attempt++;
      let response;
      try {
        response = await origFetch(url, init);
      } catch (err) {
        if (attempt <= MAX_RETRIES) {
          console.log('[proxy-global] ⚠️  Fetch retry '+attempt+'/'+MAX_RETRIES+' → node switch ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+' error: '+err.message+')');
          await triggerNodeSwitch();
          continue;
        }
        throw err;
      }
      // When dispatcher is used, undici bypasses our error detection.
      // Manually check response status for retryable errors.
      if (hasDispatcher && response && attempt <= MAX_RETRIES) {
        const status = response.status;
        if (_shouldRetryFetch(status, '')) {
          console.log('[proxy-global] ⚠️  Dispatcher response '+status+' → node switch retry '+attempt+'/'+MAX_RETRIES+' ('+urlStr.slice(0,60)+')');
          try { await response.body?.cancel?.(); } catch (e) { console.log(`[proxy-global] ⚠ Response body cancel failed: ${e.message}`); }
          await triggerNodeSwitch();
          continue;
        }
      }

      // Handle 200 responses
      if (response.status === 200) {
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        const isStreaming = ct.includes('stream') || ct.includes('event-stream');

          if (isStreaming && response.body) {
            // SSE: peek at first chunk to detect empty stream or error events
            const peek = await _peekSseStream(response.body, SSE_PEEK_TIMEOUT_MS);
            if (!peek.hasData) {
              if (attempt <= MAX_RETRIES) {
                console.log('[proxy-global] \u26a0\ufe0f  Fetch SSE empty \u2192 node switch retry '+attempt+'/'+MAX_RETRIES+' ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+')');
                await triggerNodeSwitch();
                continue;
              }
              console.log('[proxy-global] \ud83d\udd34 Fetch SSE empty body, retries exhausted ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+')');
              return new Response(
                JSON.stringify({ error: { message: 'Upstream returned empty HTTP 200 (SSE) after '+MAX_RETRIES+' node-switch retries', type: 'proxy-global_error' } }),
                { status: 502, headers: { 'Content-Type': 'application/json' } }
              );
            }
            // Check if the first SSE chunk contains an error event
            if (_isSseChunkError(peek.firstChunk)) {
              if (attempt <= MAX_RETRIES) {
                console.log('[proxy-global] \u26a0\ufe0f  Fetch SSE error chunk \u2192 node switch retry '+attempt+'/'+MAX_RETRIES+' ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+')');
                try { peek.restReader?.cancel?.(); } catch (e) { console.log(`[proxy-global] ⚠ Rest reader cancel failed: ${e.message}`); }
                await triggerNodeSwitch();
                continue;
              }
              console.log('[proxy-global] \ud83d\udd34 Fetch SSE error chunk, retries exhausted ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+')');
              // Return the error as 502 so the SDK surfaces it properly
              return new Response(
                JSON.stringify({ error: { message: 'Upstream returned error in SSE stream after '+MAX_RETRIES+' node-switch retries', type: 'proxy-global_error' } }),
                { status: 502, headers: { 'Content-Type': 'application/json' } }
              );
            }
          const liveStream = _reconstructStream(peek.firstChunk, peek.restReader);
          return new Response(liveStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }

        // Non-streaming: buffer body, check empty/error
        const bodyText = await response.clone().text();

        if (bodyText.length === 0) {
          if (attempt <= MAX_RETRIES) {
            console.log('[proxy-global] \u26a0\ufe0f  Fetch empty 200 \u2192 node switch retry '+attempt+'/'+MAX_RETRIES+' ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+')');
            await triggerNodeSwitch();
            continue;
          }
          console.log('[proxy-global] \ud83d\udd34 Fetch empty 200 body, retries exhausted ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+')');
          return new Response(
            JSON.stringify({ error: { message: 'Upstream returned empty HTTP 200 after '+MAX_RETRIES+' node-switch retries', type: 'proxy-global_error' } }),
            { status: 502, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (attempt <= MAX_RETRIES && _shouldRetryFetch(200, bodyText)) {
          console.log('[proxy-global] \u26a0\ufe0f  Fetch retry '+attempt+'/'+MAX_RETRIES+' → node switch ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+' error body)');
          await triggerNodeSwitch();
          continue;
        }
      }

      // Retryable status codes (429, 5xx) — switch node and retry immediately
      if (attempt <= MAX_RETRIES && _shouldRetryFetch(response.status, '')) {
        console.log('[proxy-global] \u26a0\ufe0f  Fetch retry '+attempt+'/'+MAX_RETRIES+' → node switch ('+((url||'').match(/\/\/([^\/]+)/)?.[1]||'?')+' status='+response.status+')');
        await triggerNodeSwitch();
        continue;
      }

      return response;
    }
  };
}

// Wrap globalThis.fetch with retry. Must happen BEFORE 9router module 39609
// captures it (bootstrap-undici.js loads this file at startup, before webpack).
if (typeof globalThis.fetch === 'function') {
  if (!globalThis.__pg_fetch_patched) {
    const orig = globalThis.fetch;
    globalThis.fetch = makeRetryableFetch(orig);
    globalThis.__pg_fetch_patched = true;
    console.log('[proxy-global] wrapped globalThis.fetch with retry');
  }
}

// ─── Agents ────────────────────────────────────────────────────────────
class ProxyHttpsAgent extends https.Agent {
  constructor() { super({ keepAlive: true, keepAliveMsecs: 60000 }); }
  createConnection(opts, cb) {
    const host = opts.host;
    if (!proxyEnabled || !shouldUseProxy(host)) return https.Agent.prototype.createConnection.call(this, opts, cb);
    const port = opts.port || 443;
    tlsTunnel(host, port).then(s => cb(null, s)).catch(cb);
  }
}
https.globalAgent = new ProxyHttpsAgent();

class ProxyHttpAgent extends http.Agent {
  constructor() { super({ keepAlive: true, keepAliveMsecs: 60000 }); }
  createConnection(opts, cb) {
    const host = opts.host;
    if (!proxyEnabled || !shouldUseProxy(host)) return http.Agent.prototype.createConnection.call(this, opts, cb);
    const port = opts.port || 80;
    tcpThroughProxy(host, port).then(s => cb(null, s)).catch(cb);
  }
}
http.globalAgent = new ProxyHttpAgent();

// ─── Apply retry wrapper ───────────────────────────────────────────────
https.request = makeRetryableRequest(https.request, true);
http.request = makeRetryableRequest(http.request, false);
http.get = function(url, options, callback) {
  var req = http.request(url, options, callback);
  req.end();
  return req;
};
https.get = function(url, options, callback) {
  var req = https.request(url, options, callback);
  req.end();
  return req;
};

console.log(`[proxy-global] initialized (proxy=${proxyEnabled ? proxyUrl : 'none'}, retry=${MAX_RETRIES}x, bypass=${bypassMode})`);


module.exports = { enabled: proxyEnabled, proxyUrl };

