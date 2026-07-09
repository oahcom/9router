
## 操作规范

### 开关控制

```bash
~/.9router/toggle-proxy-global.sh off    # 关闭 proxy-global.js (9router 仍运行)
~/.9router/toggle-proxy-global.sh on     # 开启 proxy-global.js (完整功能)
~/.9router/toggle-proxy-global.sh status # 查看状态
```

| 状态 | nine-router.service | proxy-global.js | 9router 流量 |
|------|-------|------|------|
| off | active | DISABLED (跳过 monkey-patch) | ✅ 正常 |
| on | active | ENABLED (全部功能) | ✅ 正常 |

两种状态都保持 9router 运行。off 只是跳过 proxy-global.js 的 monkey-patch 层。

### 重启 9router

**严禁**: 直接 `kill` next-server 进程（claude/spawner 也可能连带死掉）

**正确**:
```bash
systemctl --user restart nine-router
```

### 后台启动

通过 systemd 管理，不要手动启动。

```bash
systemctl --user start nine-router
```

## 关键规则

- 停/启 9router 永远用 `systemctl --user restart/stop/start nine-router`
- `proxy-global.js` 在 `~/.9router/` 目录，不在 git 里
- `~/.9router/AGENTS.md` 只有 `--require` 加载时读取
- 每次修改后执行健康检查确认服务就绪

## 架构说明

### 请求链路

```
Client (Hermes/daemon/cron)
  │  HTTP POST http://localhost:20128/v1/chat/completions
  ▼
nine-router.service (systemd, port 20128)
  │  运行 9router Next.js 服务
  ▼
proxy-global.js (--require 加载, 可通过 disabled 文件跳过)
  │  Monkey-patch: globalThis.fetch + https/http.globalAgent
  │  功能: 重试(10次) + 节点切换(sing-box Clash API) + 熔断器
  ▼
sing-box (端口 7890, 56 anytls 节点)
  │  Clash API: 127.0.0.1:9090
  ▼
上游 Provider (opencode.ai / xiaomi-tokenplan / ...)
```

**注意**: 9router 内部还有独立的 `proxyAwareFetch` (undici ProxyAgent → sing-box:7890)，不走 proxy-global.js 的 monkey-patch。所以关掉 proxy-global.js 不影响 9router 基本流量。

### proxy-global.js 联动关系

```
systemd nine-router.service
  └─ NODE_OPTIONS="--require=proxy-global.js ..."
       └─ proxy-global.js monkey-patch
            ├─ Layer 1: Agent 代理路由 (http/https.globalAgent → sing-box:7890)
            ├─ Layer 2: 重试 + 节点切换 + 坏节点追踪
            └─ Layer 3: 熔断器 (连续3次失败 → 120s快速失败)

同时 9router 内部还有:
  └─ proxyAwareFetch (39609模块) — 9router 自己的代理处理
       ├─ 读取 settings.outboundProxyEnabled/outboundProxyUrl
       └─ 连接失败时 fallback 到直连
```

**注意**: proxy-global.js 和 proxyAwareFetch 是两套独立的代理逻辑，改一个不影响另一个。

### 9router 源码关键模块

| 模块 | 文件 | 功能 |
|------|------|------|
| `proxyAwareFetch` | 318.js / 212.js 等 (module 39609) | 9router 内部用 undici ProxyAgent 直连 sing-box:7890 |
| opencode provider | 318.js module 4493 | `class j extends d.H` — 直接继承 BaseExecutor |
| opencode provider 配置 | 255.js module 30255 | 所有 provider 的 transport/baseUrl 定义（内置不可配） |
| BaseExecutor | module 74957 | 所有 provider 基类 |
| DefaultExecutor | module 96179 | 默认 executor |
| combo fallback `p()` | 8910.js | 模型级降级逻辑 |
| `hk()` 决策函数 | 3662.js | 判断是否 fallback |
| 超时常量 | 6070.js module 41004 | `FETCH_CONNECT_TIMEOUT_MS` 默认 60000 |

### opencode provider 配置详情（源码逆向）

**baseUrl**: `https://opencode.ai`（硬编码在 module 30255，用户不可配）

**完整请求 URL**:
- 默认: `${baseUrl}/zen/v1/chat/completions`
- 特定模型（Set `g` 控制）: `${baseUrl}/zen/v1/messages`

**Auth Headers**（硬编码）:
```
Authorization: "Bearer public"
x-opencode-client: "desktop"
Content-Type: "application/json"
Accept: "text/event-stream"
```

**源码位置**: `318.js module 4493`
```javascript
class h extends d.H {
  constructor() {
    super("opencode", e.xq.opencode)  // e.xq = module 35024 → 26070 → 30255
  }
  buildUrl(a) {
    let b = this.config.baseUrl;  // = "https://opencode.ai"
    return g.has(a) ? `${b}/zen/v1/messages` : `${b}/zen/v1/chat/completions`
  }
  buildHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "x-opencode-client": "desktop",
      Accept: "text/event-stream"
    }
  }
}
```

**配置链路**: module 30255 (`d.A` 数组) → `p[a.id]` 构建 `xq` 对象 → module 35024 导出 `xq` → module 4493 读取 `e.xq.opencode`

**opencode-go 是独立 provider**: URL `https://opencode.ai/zen/go/v1`，auth 不同（anthropic 模型用 `x-api-key`）

**关键**: `proxyAwareFetch` 用 undici ProxyAgent，不走 `globalThis.fetch`。所以 proxy-global.js 的重试/断路器对 9router 内部请求无效。

## 环境变量配置

配置位置：`~/.config/systemd/user/nine-router.service.d/timeout-tuning.conf`

| 变量 | 当前值 | 说明 |
|------|--------|------|
| `STREAM_STALL_TIMEOUT_MS` | 30000 | 流停顿超时（上游接受连接但不返回数据） |
| `STREAM_FIRST_CHUNK_TIMEOUT_MS` | 15000 | 首 chunk 超时 |
| `FETCH_CONNECT_TIMEOUT_MS` | 5000 | TCP 连接超时 |

## 超时机制详解

### STREAM_STALL_TIMEOUT_MS

控制 `fetch connect timeout` 错误的时间点：
- 当上游接受 TCP 连接但 30s 内不返回任何数据时触发
- 失败请求集中在 `timeout_ms ± 500ms` 范围内
- 改大可让更多慢请求成功，但也会增加等待时间

### FETCH_CONNECT_TIMEOUT_MS

控制 TCP 连接建立的超时：
- 当 TCP 握手在 5s 内未完成时触发
- 比 STREAM_STALL_TIMEOUT_MS 更底层

## 常见问题

### fetch connect timeout

**三种可能原因**:

1. **proxy-global.js 熔断器** — 连续3次跨节点失败后触发120s快速失败
   - 日志: `Circuit breaker open for opencode.ai, skip retry`
   - 解决: 等待120s熔断恢复，或重启服务

2. **proxyAwareFetch 代理失败** — 9router内置代理连接超时
   - 日志: `[ProxyFetch] Proxy failed, falling back to direct`
   - 原因: sing-box 连接问题或 opencode 上游响应慢
   - 排查: 检查 sing-box 状态 `ss -tlnp | grep 7890`

3. **opencode 上游 stall** — 上游接受连接但不处理请求
   - 表现: 30s后超时，ttft=0
   - 原因: opencode 服务端问题，非客户端问题

### Upstream request failed

- **来源**: opencode 上游服务返回的错误（不是 9router 超时）
- **表现**: 请求在 2-4s 内快速失败，返回 `"Error from provider (Console): Upstream request failed"`
- **原因**: opencode 服务端拒绝请求（限流/模型下线/服务异常）
- **排查**: 尝试不同模型（如 `oc/mimo-v2.5-free`）确认是否特定模型问题
- **配置**: baseUrl/auth 均为硬编码，不可通过 9router 配置修改

### Upstream temporarily unavailable

- **原因**: proxy-global.js 熔断器触发
- **表现**: 120s 内所有请求直接返回 502
- **日志**: `Upstream temporarily unavailable after 3 retries`
- **解决**: 等待熔断恢复或重启服务

### 代理连接失败但代理本身正常

**排查步骤**:
1. `ss -tlnp | grep 7890` — 确认 sing-box 在运行
2. `curl -x http://127.0.0.1:7890 https://opencode.ai` — 测试代理连通性
3. 检查 sing-box 活跃连接数 — `curl -H "Authorization: Bearer $SECRET" http://127.0.0.1:9090/connections`
4. 检查 9router 进程 TCP 连接 — `ss -tnp | grep <PID>`
