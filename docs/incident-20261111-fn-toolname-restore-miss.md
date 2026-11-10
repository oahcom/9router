# Incident 2026-11-11: fn_<hash> 工具名还原丢失导致 "No such tool available"

## 症状

使用 `custom-local:9router_hermes`（转发至 opencode/deepseek-v4.1-flash-free）的 session，所有工具调用（shell / read / skill / subagent）均报 `No such tool available: fn_18vix4v`，重试两次后 session FAILED。

WorkBuddy 侧日志（`.workbuddy/logs/...`）：

- `streamingToolName=fn_18vix4v`
- `Tool fn_18vix4v not found in agent cli.`
- `ModelBehaviorError: Tool "fn_18vix4v" not found (deferred: false)`
- `retry suppressed - max retries reached`

## 根因

9router 为绕开上游模型对特定工具名（如 `subagent_fork`）的 429 限制，在请求侧把 caller 工具真名改写成稳定中性别名 `fn_<hash>`（FNV-1a，7 位 base36），响应侧再还原回真名。

肇事生成代码：`open-sse/utils/opencodeFingerprint.js:218`

```js
const base = `fn_${h.toString(36).padStart(7, "0")}`;
```

双向机制：

- 请求侧 `neutralizeCallerToolNames()` + `applyFingerprintTools()` 改名，map 存入 WeakMap `renamedToolNames`（key = transformRequest 收到的 body 引用）。
- 响应侧 `restoreToolNames(payload, map)` 还原，`stream.js:198` 以 `if (toolNameMap?.size)` 守卫。

## 断点

`restoreToolNames` 首行 `if (!map?.size || !payload) return payload` —— map 为空时**静默原样返回**，不还原、不报错。

map 取不到的根因：`chatCore.js:421` 原实现为 `takeRenamedToolNames(translatedBody)` 单点取。但：

- `base.js:333` `this.transformRequest(model, replayBody || body, ...)`
- `opencode.js:686` `const replayBody = cloneRequestBody(args.body)` —— replayBody 是克隆体，**永远 truthy**。
- 因此 transformRequest 永远在 replayBody（克隆体）上 set map，而 chatCore 拿 translatedBody（原引用）去取 → WeakMap 按引用匹配，取不到 → toolNameMap 为空 → passthrough 路径（openai→openai）裸透传 `fn_xxx` → 客户端 not found。

历史旁证：`stream.js:191-195` 注释记录的 issue #4986 是同一根因复发（那次别名是 `read_client`）。

## 修复

核心思路：不再依赖 body 引用匹配，在 map 生成点（引用确定）显式取出、显式传递。

| 文件 | 行 | 改动 |
|---|---|---|
| `open-sse/executors/base.js` | 8 | `import { takeRenamedToolNames } from "../utils/opencodeFingerprint.js"` |
| `open-sse/executors/base.js` | 397-398 | transformRequest 后 `const renamedToolMap = takeRenamedToolNames(replayBody || body)`（与 333 行同表达式，引用必匹配），加入 `return { ..., renamedToolMap }` |
| `open-sse/handlers/chatCore.js` | 421 | `result.renamedToolMap || takeRenamedToolNames(translatedBody) || takeRenamedToolNames(finalBody)` —— 优先用显式带出的 map，双取兜底 |

## 验证

- `npm run build` 成功（1m58s，exit 0；egress.js critical-dep 警告为既有，与本次无关）。
- `sudo systemctl restart 9router` → `active (running)`，端口 20127 监听。
- 重启后 9router journal 30 秒内无 `fn_` / `tool not found` / `error`。
- hermes combo（→ deepseek-v4.1-flash-free）请求正常完成：`req=wb5ui2801 DONE 21291ms · OUT 1109 · COMBO succeeded`。
- passthrough 路径（openai→openai）运转正常。

## 回滚

备份：

- `open-sse/handlers/chatCore.js.bak-20261111-fn-fix`
- `open-sse/executors/base.js.bak-20261111-fn-fix`

```sh
cp open-sse/handlers/chatCore.js.bak-20261111-fn-fix open-sse/handlers/chatCore.js
cp open-sse/executors/base.js.bak-20261111-fn-fix   open-sse/executors/base.js
npm run build && sudo systemctl restart 9router
```

## 相关

- 设计注释：`open-sse/utils/opencodeFingerprint.js`（`neutralizeCallerToolNames` / `restoreToolNames` / `applyFingerprintTools`）。
- 历史同类：issue #4986（`stream.js:191-195` 注释）。
- 应急开关：`OPENCODE_NEUTRALIZE_TOOL_NAMES=off`（关闭中性化；代价是可能重新撞上游 429 工具名黑名单）。
