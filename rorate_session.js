#!/usr/bin/env node
/**
 * 9Router OpenCode Session Header Rotator Proxy (FINAL FIXED VERSION)
 * 
 * ALWAYS generates completely new x-opencode-project + fresh b3/traceparent
 * to bypass OpenCode rate limit tracking per IP + session headers.
 * 
 * Usage: node session-rotator-fixed.js
 * Server: http://localhost:20126
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PROXY_PORT = 20217;
const PROXY_HOST = '127.0.0.1';

const SESSION_HEADER_PATTERNS = [
  /^x-session/i,
  /^x-opencode-session/i,
  /^x-client-session/i,
  /^x-amz-date/i,
  /session-id/i,
];

const MAX_PROJECT_LENGTH = 40;

// Generate completely random x-opencode-project (mimics real format)
function generateRandomProjectId() {
  const hex = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < MAX_PROJECT_LENGTH; i++) {
    id += hex[Math.floor(Math.random() * 16)];
  }
  return id;
}

// Generate fresh random b3
function generateRandomB3() {
  const randomHex = (length) => 
    Array.from({ length }, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  const parentSpanId = randomHex(16);
  return `${traceId}-${spanId}-1-${parentSpanId}`;
}

// Generate fresh random traceparent
function generateRandomTraceparent() {
  const randomHex = (length) => 
    Array.from({ length }, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  return `00-${traceId}-${spanId}-01`;
}

// Clear all dangerous session headers
function clearSessionHeaders(headers) {
  const cleaned = { ...headers };
  const removed = [];

  // Remove all session-related headers
  for (const key of Object.keys(cleaned)) {
    if (SESSION_HEADER_PATTERNS.some(pattern => pattern.test(key))) {
      delete cleaned[key];
      removed.push(key);
    }
  }

  // Remove x-opencode-project completely
  if (cleaned['x-opencode-project']) {
    delete cleaned['x-opencode-project'];
    removed.push('x-opencode-project');
  }

  // Remove x-opencode-client if present (keep x-opencode-client: cli though)
  if (cleaned['x-opencode-client'] && cleaned['x-opencode-client'] !== 'cli') {
    delete cleaned['x-opencode-client'];
    removed.push('x-opencode-client');
  }

  // Filter cookies
  if (cleaned.cookie) {
    const cookies = cleaned.cookie.split(';').map(c => c.trim());
    const filtered = cookies.filter(cookie => {
      const name = cookie.split('=')[0].toLowerCase();
      return !/(session|sid|opencode|auth|token|x-session)/i.test(name);
    });
    if (filtered.length > 0) {
      cleaned.cookie = filtered.join('; ');
    } else {
      delete cleaned.cookie;
    }
    removed.push('cookie');
  }

  return { cleaned, removed };
}

// Main handler
function handleRequest(clientReq, clientRes) {
  let bodyChunks = [];
  clientReq.on('data', chunk => bodyChunks.push(chunk));
  clientReq.on('end', () => {
    const bodyBuffer = Buffer.concat(bodyChunks);
    const originalHeaders = clientReq.headers;

    // Clear dangerous headers
    const result = clearSessionHeaders(originalHeaders);
    let headersToSend = result.cleaned;
    const removedHeaders = result.removed;

    // === CRITICAL: ALWAYS generate NEW project + tracing headers ===
    const newProjectId = generateRandomProjectId();
    const newB3 = generateRandomB3();
    const newTraceparent = generateRandomTraceparent();

    headersToSend['x-opencode-project'] = newProjectId;
    headersToSend['b3'] = newB3;
    headersToSend['traceparent'] = newTraceparent;

    // Keep only the essential ones
    headersToSend['x-opencode-client'] = 'cli';
    headersToSend['content-type'] = 'application/json';
    headersToSend['user-agent'] = 'opencode/latest/2.1.2/cli';
    headersToSend['connection'] = 'close';   // Important for new session feel

    // Host must point to 9router
    headersToSend.host = 'localhost';

    // Debug - show ALL headers being sent
    console.log(`[${new Date().toISOString()}] 🔄 Cleared: ${removedHeaders.join(', ') || 'none'}`);
    console.log(`[${new Date().toISOString()}] 📋 FINAL HEADERS:`);
    Object.keys(headersToSend).sort().forEach(key => {
      let value = String(headersToSend[key]);
      if (value.length > 80) value = value.substring(0, 80) + '...';
      console.log(`  ${key}: ${value}`);
    });

    const proxyOptions = {
      hostname: '127.0.0.1',
      port: 20218,
      path: clientReq.url,
      method: clientReq.method,
      headers: headersToSend,
    };

    const proxyReq = http.request(proxyOptions, proxyRes => {
      console.log(`[${new Date().toISOString()}] ✓ Backend response: ${proxyRes.statusCode}`);

      let responseChunks = [];
      proxyRes.on('data', chunk => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        const responseBuffer = Buffer.concat(responseChunks);
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        clientRes.end(responseBuffer);
      });
    });

    proxyReq.on('error', err => {
      console.error(`[${new Date().toISOString()}] ❌ Proxy error: ${err.message}`);
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    });

    // Send request body if present
    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
}

const server = http.createServer(handleRequest);
server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║         🚀 9Router OpenCode Rotator Proxy (FINAL FIXED) Started       ║
║                                                                    ║
║  Listening on: http://${PROXY_HOST}:${PROXY_PORT}                    ║
║  Features:                                                         ║
║  • Always sends completely NEW x-opencode-project + b3/traceparent  ║
║  • Removes all session tracking headers                             ║
║  • connection: close for new session feel                           ║
╚════════════════════════════════════════════════════════════════════╝
  `);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PROXY_PORT} is in use`);
  } else {
    console.error(`❌ Server error: ${err.message}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.close(() => process.exit(0));
});
