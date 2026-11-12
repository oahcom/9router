# 2026-11-09 传输层 503 与 SSE 字节流中断

> 事故编号：INC-2026-11-09-01
> 观测窗口：2026-11-09 09:06 – 14:31（CST），跨两次部署
> 分析方法：只读取证（`~/.9router/db/data.sqlite` 的 requestDetails 滚动窗口、
> `journalctl -u 9router.service`、`auto-switch-ip/daemon.log`、sing-box 日志），
> 不含推测性改动。所有数字附可复现命令。
>
> 姊妹文档：`docs/opencode-503-analysis.md`（2026-10-27，端口 7000 死备用出口
> 那一类根因）。本文是**另一条**根因链，不要混用结论。

## 1. 结论摘要

503 与「字节流传输中断」是**同一条因果链的两段**，不是两个独立故障：

```
opencode 免费层 quota 429（按出口 IP 计）
  → asip rate429 换线（最短 4 秒 2 次）
  → 换线后的「断旧链」清理按 age≥120s 判僵尸，把仍在传字节的大上下文 SSE 掐断
      = 用户看到的「字节流传输中断」
  → 死 socket 留在 Bun sidecar 池里 → retire / 重启风暴（4 分钟 24 次）
  → executor 拒绝 Node 兜底（免费层需 Bun 客户端指纹）→ 503
      = 用户看到的 503
  → 客户端并发重试 → 错误率升高 → 再次触发换线（放大器）
```

三个独立缺陷叠加，缺一个都不会演变成这场风暴：

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| A | 换线后按 `age≥120s` 清连接 | `daemon.py` `_close_opencode_connections` | 大上下文请求（实测 140–242s）必被误杀，字节流中断 |
| B | 退役 sidecar 30s 后 SIGKILL | `opencodeTransport.js` `RETIRE_MAX_MS` | 一个请求失败连坐同进程里的健康长流 |
| C | 无首字节超时「绝不换线」 | `opencode.js` `retryOnceAfterStall` | 出口真的挂了也只会在原出口重试一次，第二次超时直接 503 |

## 2. 证据

### 2.1 503 画像（09:06–10:02，共 239 条）

```bash
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('file:/home/administrator/.9router/db/data.sqlite?mode=ro',uri=True)
for r in c.execute("select model,status,count(*) from requestDetails "
                   "where status='error' group by 1,2 order by 3 desc limit 5"):
    print(r)
PY
```

- 模型：**全部** `oc/deepseek-v4.1-flash-free`（opencode 免费层）
- 请求体：250–750 KB；延迟 140–180 s；`ttft=0`（一个字都没吐出来）
- 错误原文：

```
[503] UpstreamTransportError: OpenCode free lane requires the Bun transport;
      sidecar unavailable (upstream-fetch-failed)
```

### 2.2 时间线对齐

| 时刻 | 事件 | 来源 |
|---|---|---|
| 09:06:48 / 09:06:52 | 4 秒内连换两次出口 WG-6 → SIN-65 → HKG-9 | daemon.log |
| 09:06–09:46 | 34 次 WARP 换线（15 次由 rate429 触发） | daemon.log |
| 09:18–09:22 | sidecar 重启 **24 次** | journalctl |
| 09:51 / 10:06 | sidecar 被重新拉起 | `ps -o lstart` |
| 10:23:07 | WARP-CF-B 上请求连续 20 s 无响应头 | journalctl |
| 10:23:39 | daemon 判定该出口失败 | daemon.log |
| 10:23:40 → 10:24:01 | 切到 WARP-WG-8，请求恢复 | daemon.log |
| 13:37–13:38 | `502 fetch connect timeout`，延迟 **252 s** | requestDetails |

### 2.3 关键代码证据

`daemon.py` 的实测注释（作者自己记的，不是推断）：

> age 筛不出僵尸。实测 age>=120s 的连接 **85% 仍在传字节**（age>=180s 时 100%，
> 最长 242s 仍在传），清它们等于掐断在途请求。

`opencode.js` 的旧注释（本次被推翻的假设）：

> 无首字节超时：出口还活着，只是 sidecar 池里那条连接死了。
> 单池部署下没有第二条出口可换，唯一能做的是换一条新连接再试一次 ——
> 不换线是刻意的，换线归 429/403 那条路径管。

现场恰好相反：**出口探测失败，换到 WARP-WG-8 后请求立即恢复**。也就是说
「不换线」的假设在“出口真的挂了”这条分支上是错的。

## 3. 修复

| commit | 仓库 | 内容 |
|---|---|---|
| `faf4ce90` | .9router | 传输失败（`header-timeout` / `upstream-timeout` / `upstream-fetch-failed`）先经 asip 同步换线，再用新 generation 重放**一次**；ASIP 不可用时保留“新连接重试”兜底；退役 sidecar 删除 30s SIGKILL，改为等在途响应自然结束后回收 |
| `001ae9e` | auto-switch-ip | `/rotate` 新增 `reason=transport`：`interrupt=false`（不断在途连接）、**不写 blocked 台账**（transport 不是 429/403 的封禁证据） |
| `5d5a929` | auto-switch-ip | 删除全局额度闸 `_QUOTA_HOLD`：配额按出口 IP 计，重启换 IP 即新配额，“长 Retry-After 应冻结换线”立论错误（违反 INC-008 红线）。防白烧交给渠道锁 + 每线每小时 20 次上限 |
| `f6f4ce5e` | .9router | `base.js` 连接超时（连响应头都建不起来）也换线重放一次：仅对 `proxyOptions.url` 指向本机 sing-box（`127.0.0.1:7890`）的请求生效，**严格一次 + 15s 冷却**，直连/局域网代理/asip 关闭时保持原“直接抛” |

### 3.1 判据边界（为什么这样切）

- **为什么 `transport` 不记脏**：换线是“这条线连不上”，不是“这个 IP 被上游封了”。
  记脏会把一条其实干净、只是网络抖动的地址永久踢出候选池，而池里已经有
  119/170 节点 dead。
- **为什么连接超时要门控**：asip 换的是 sing-box 里那条 WARP 线的 selector。
  局域网里另一台机器的 `192.168.100.104:7890`、直连 provider、Vercel relay
  都不走本机 selector，对它们调 `/rotate` 只会白烧一条本地好线。
- **为什么要 15s 冷却**：一条真坏掉的端点（域名写错、对端长期不可达）会持续
  连接失败，每个请求换一次线就是把出口池当消耗品。

## 4. 部署规程（本次踩过的坑，务必按此执行）

### 4.1 改 `open-sse/` 必须重新 build

`open-sse/` 被 webpack 打包进 `.next/server/chunks/*.js`。只改源码 + 重启服务
= **线上仍是旧代码**，且日志里看不到任何异常。项目自带判定：

```bash
cd ~/.9router && bash scripts/check_deploy_state.sh
# 0 MATCH / 1 MISMATCH / 2 UNAVAILABLE / 3 STALE_SOURCE
```

`3 STALE_SOURCE` 就是“改了源码没构建”。本次两次部署前都是这个状态。

### 4.2 零停机换产物（推荐流程）

```bash
export PATH=/home/administrator/.nvm/versions/node/v22.23.1/bin:$PATH
cd ~/.9router

# 1) 构建到独立目录：线上继续跑旧 .next，构建期间不受影响
rm -rf .next.new
NEXT_DIST_DIR=.next.new npm run build      # 约 2 分钟

# 2) 原子切换 + 重启（停约 10 秒）
sudo systemctl stop 9router.service
mv .next .next.prev.$(date +%H%M%S)
mv .next.new .next
[ -d .next/standalone/.next.new ] && mv .next/standalone/.next.new .next/standalone/.next

# 3) 起服务并严格校验
sudo systemctl start 9router.service
sleep 12
bash scripts/postdeploy_gate.sh strict     # 必须 MATCH，否则这次重启跑的是旧代码
```

### 4.3 三个会让部署“静默失败”的坑

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 漏 `sudo` | `Failed to restart 9router.service: Interactive authentication required.` | `sudo systemctl restart`（`sudo -n true` 可验证免密） |
| 管道吞退出码 | `cmd \| tr -d '\0'` 的退出码是 `tr` 的，永远是 0 | 用 `systemctl show -p ActiveEnterTimestamp` / `cat .next/BUILD_ID` 事后核对 |
| `nohup ... &` 构建 | WSL 会话退出把子进程一并回收，构建 1 分钟静默死亡、日志无报错 | 用受管后台任务跑构建 |

## 5. 验证

```bash
# 部署态
bash scripts/postdeploy_gate.sh strict
#   disk=J0BgJIBAzx4vRifL4pFdQ runtime=J0BgJIBAzx4vRifL4pFdQ MATCH

# 新逻辑确实进了产物（字符串字面量在打包后仍保留）
grep -rl 'after asip rotation' .next/server/chunks/     # → 5330.js
grep -rl 'rotation in cooldown'  .next/server/chunks/   # → 4957.js
# 旧构建里这两条都搜不到，可用来区分「构建了」和「没构建」

# asip 换线接口（transport 语义）
# {"ok":true,"switched":true,"tag":"WARP-CF","closed":0,...}
#   closed=0 就是「没有掐断任何在途连接」的直接证据
```

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 错误率 | 11 点 32 条/小时、12 点 30 条/小时 | 14:18 与 14:31 两次重启后均 **0 错误**（累计 159 次请求） |
| 换线频次 | 08 点 24 次 / 09 点 10 次 / 10 点 15 次 | 12 点 3 次 / 13 点 4 次 / 14 点 1 次 |
| 请求延迟上限 | 失败请求 252 s 才放弃 | 一次连接超时最多多等一个 60s 窗口 |

## 6. 残留风险

1. **免费层 quota 429 仍在**，这是设计内行为（按 IP 计额度 → 换线即新配额）。
   它不再引发风暴，但量大时换线开销仍在。
2. **出口池健康度**：WARP-H2-SCAN 系列整批 dead（曾 119/170），池容量不足会让
   换线更容易撞到已烧地址。渠道锁拦得住“整批全 quota”，但拦不住“池子太小”。
3. **退役 sidecar 的收尾**：现在只靠 `inflight` 归零回收（`opencodeTransport.js`
   L179-180）。正常路径不会泄漏；只有“既不结束也永不 abort”的流会把那个进程
   一直留着。刻意不加计时器 —— 加回去就等于把 30s 截断问题装回原样。
4. **`_QUOTA_HOLD` 已删除**，若日后出现与 INC-008 结论相反的新证据，
   应由渠道锁按线判定，不要复活全局闸。

## 7. 相关文档

- `docs/opencode-503-analysis.md` — 2026-10-27 另一条根因链（端口 7000 死出口）
- `~/dkk-projects/auto-switch-ip/INCIDENTS.md` — INC-005/008/010/012 与本次直接相关
- `~/dkk-projects/auto-switch-ip/docs/established-facts.md` — 「结论说的是地址还是线路」

---

## 8. 第二轮（15:0x）：不是池子没 IP，是自己把出口重启没了

> 触发：主人一句「不是呀，每个隧道池都有很多待命的代理 ip」。
> 这句话推翻了上一轮「仅剩约 19 条出口」的判断 —— 那个数字是某一瞬间的探测
> 快照，不是池子容量。按池子容量重查，结论完全反过来。

### 8.1 池子到底有多大（15:00 实测）

| 项 | 数量 |
|---|---|
| `singbox-config.json` 出口 | **229** 个 outbound（anytls 160 / trojan 2 / vless 7 / socks 57 / direct 1 + selector 2） |
| `proxy` selector 候选 | **170** |
| `opencode-out` selector 候选 | **58** |
| `usque-h2-*` 单元 | **79 个，全部 running，0 failed** |
| WARP 线成员 | 57 条，其中 **30 条当下有出口 IP** |
| `/debug/state` fresh_candidates | **25 条**（`no_standby=0`，即从不缺备线） |

主人是对的：**供给从来不缺**。上一轮把「探测瞬时失败」读成了「池子空了」。

### 8.2 真正的病：30 分钟 466 次隧道重启

同一时间窗（14:24–14:55）的 `asip-unit restart` 计数：

```
174  warp-wg-5        100  warp-wg-13        56  warp-wg-9
 14  usque-h2-71       11  usque-h2-69        9  usque-h2-65
```

合计 **466 次 / 30 分钟 = 每 3.9 秒一次**。其中 `warp-wg-5` 每 8~10 秒重启一次，
而它每次拿回的出口只有两个值：`104.28.205.115` / `104.28.205.117`（CF 共享 IPv4）。
**「重启换 IP」在这条线上根本不成立**，换回来的还是同一个被烧过的地址，于是
「出口处于惩罚期」→ 重启 → 又同一个地址 → 再重启，死循环。

同时 `sing-box` 主进程（7890，9router 的唯一出口）在 30 分钟内被重启 4 次：

```
14:53:12 ⚠ 重启 sing-box → 14:53:25 ✓        (13s 空窗)
14:53:40 ⚠ 重启 sing-box → 14:53:53 ✓        (13s 空窗)
14:55:03 ⚠ 重启 sing-box → 14:55:16 ✓        (13s 空窗)
14:55:44 ⚠ 重启 sing-box → 14:55:57 ✓        (13s 空窗)
```

空窗来自 `restart_singbox()`：`pkill` → `sleep 2` → `fuser -k 7890` → `sleep 1`
→ 新 `Popen` → `startup_grace_sec`(10s)，合计 **约 13 秒端口无人监听**。

### 8.3 503 时间戳与重启时刻逐一对上

```
14:53:15  4 个 503   ← 14:53:12~25 重启窗口
14:53:43  4 个 503   ← 14:53:40~53 重启窗口
14:55:03 12 个 503   ← 14:55:03~16 重启窗口
14:55:44 18 个 503   ← 14:55:44~57 重启窗口
```

底层错误是 `ECONNREFUSED: Unable to connect`（30 分钟 20 次），不是超时、不是 429。
**9router 连本地 7890 都被拒了** —— 所以这一批 503 与上游、与配额、与 IP 全都无关。

而触发这 4 次重启的原因更荒诞：`✓ 订阅刷新完毕（池子成员 169 → 169）`。
当天 9 次刷新里 8 次是同一份内容（169 → 169），每次都照样 `pkill` 重来一遍。

### 8.4 四处改动

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `refresh_subscription()` | 配置没变也重启 sing-box | `_config_semantically_equal()` 比对 outbounds 指纹；一致就跳过，进程不在才 `restart_singbox()` |
| 2 | `restart_singbox()` 调用点 | 配置级动作只能靠杀进程 | 新增 `reload_singbox_config()`：`PUT /configs?force=true`（Clash API），失败才回退整进程重启 |
| 3 | `_install_h2_lines()` | `"CHANGED" in "UNCHANGED"` 恒真 → 无变更也重启 | 按词精确匹配 |
| 4 | `_warp_line_restart()` | 换不到新地址仍无限重启 | 「换地址熔断」：连续 3 次重启拿回同一 IP → 900s 内不再重启；「惩罚期熔断」：连续 3 次重启后仍 blocked/quota → 同样熔断 |

熔断的语义边界（重要，别被误读成"加回重启上限"）：

- **只拦「换了没用」的重启**。第一次、第二次照常换 IP —— 主人「重启换 IP =
  新配额」的规则完整保留。
- `tunnel_dead`（连地址都拿不到）不受熔断约束：那是隧道坏了，只能重启。
- 拿到 `OK` 立刻清熔断与计数。
- 与 `restart_max_per_hour_per_line=0` 不冲突：那条是"次数上限"，这条是
  "效果判据"，两者正交。

顺带修掉 `/rotate` 的一个回传 bug：`self._send(200, _rotate_once(...))` 之后又用
未定义的 `result` 再发一次，**每次换线都抛一次 NameError**，栈打满日志、
`client_gone` 记账永远走不到。换线本身是成功的，坏的只是回传。

### 8.5 实测效果

热重载能力先单独验证（`PUT /configs?force=true`，50ms 粒度探测 7890）：

```
PUT http_code=204  elapsed=0.01s  port probe fails=0
```

部署后（15:20 起）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| sing-box 重启 | 4 次 / 30 min（每次 13s 空窗） | **0 次**（pid 1090722 跨多次 daemon 重启不变） |
| 9router 503 | 86 条 / 30 min | **0 条 / 10 min（44 次请求）** |
| 隧道重启 | 15.5 次 / min | **8 次 / min** |
| 熔断日志 | — | 11 条线各 1 条，收敛 |
| 端到端 | 5 并发同秒全 503 | 单流 200 / 1.7s、5 并发 **5/5 成功且 `[DONE]` 完整** |
| 回归 | — | `pytest` **924 passed** |

`systemd` 侧确认出口未被牵连：

```
auto-switch-ip.service: Unit process 1090722 (sing-box) remains running after unit stopped.
auto-switch-ip.service: Found left-over process 1090722 (sing-box) ... Ignoring.
```

（`KillMode=process` drop-in 早已存在，这次才算真正被用上。）

### 8.6 这条链上还剩什么

1. **header-timeout 型 503 独立存在**：`upstream header timeout (20000ms)` 是
   opencode 免费层对超配额 IP 的静默行为（不返回 429，挂着不回）。它与本轮
   修的"重启掐断"是两回事，量大的时候仍会看到 503。要压它只有两条路：
   缩短首字节等待 + 换线重放（更快失败），或扩大可用出口池。
2. ~~**59 条休眠出口（`dormant-outbounds.json`）一直没进 selector**：池子里还躺着
   65 条 anytls 待命节点。若 header-timeout 型 503 仍多，优先让它们入池，
   而不是加更多重启。~~
   **【§9.1 已证伪】** 65 条全在 `proxy`（170 成员，默认出口就是其中一条）；
   而且 `opencode.ai` 直接路由到 `opencode-out`（WARP 专用），机场节点不参与
   opencode 流量，扩充 `proxy` 对这类 503 无效。
3. **渠道锁仍锁着 47 条线到次日 08:00**（`channel_ban`，判据是当天 1000 条
   实测全 quota）。这是策略不是 bug，但它把可用供给砍掉 1/3 —— 池子吃紧时
   要先看它，而不是改重启参数。

---

## 9. 第三轮（15:2x–16:0x）：503 只剩一种形状 —— 20s + 20s 打在同一个出口上

### 9.1 先把上一轮的判断纠正掉

上一轮结尾我写了「`dormant-outbounds.json` 里 65 条 anytls 一直没进 selector，
池子还有货没放出来」。**这条是错的**，实测：

```
dormant 总数: 65   在当前配置里: 65   缺失: 0
SELECTOR proxy  members: 170  default: hk-aws-122.acczzz.com:443-any   含 dormant 成员: 65
SELECTOR opencode-out  members: 58  default: WARP-CF   含 dormant 成员: 0
```

65 条早就在 `proxy` 里，而且当前默认出口就是其中一条。但更要紧的是第二行：

**opencode 流量根本不走 `proxy`。** 路由规则把 `opencode.ai` 直接钉到
`opencode-out`（16 WG + 32 H2 + 10 个固定 CF 出口 + `proxy` 兜底）。
所以「把 65 条并进 selector、池子 170 → 235」对 opencode 的 503 一条都治不了 ——
那 170 个机场出口是给普通流量的，不是给 free lane 的。

### 9.2 修复后的残留不是"没修好"，是另一种病

15:20 之后再统计，错误只剩三种，且 503 全是同一个签名：

| 项 | 数量（15:20–15:55） |
|---|---|
| 请求 | 422（392 成功 / 30 失败） |
| `ERROR 503` | 13 |
| `ERROR 429` | 10（全被 combo 第 2 个模型吸收） |
| `ERROR 400` | 7（body 超限，3.6MB 实测必 400） |
| `header timeout` 日志 | 41 次 |

每条 503 的记录都是 `latency.total ≈ 43000ms`、`ttft = 0`、body 165–515KB。
日志里对应的序列（`req=w8ygwtg1y`）：

```
15:44:53 upstream header timeout (20000ms) -> EGRESS transport stall -> asip rotation (ok)
15:45:13 upstream header timeout (20000ms) -> ERROR 503 · 43118ms
```

**两次 20 秒，是同一个出口。**

### 9.3 为什么换线换了个寂寞

`_opencode_lane_alive()` 打的是 `max_tokens: 1`、prompt 为 `"1"` 的最小 free-lane
请求，任何 HTTP 响应（含 429）都算活。于是：

```
[15:41:42] ⚠ 传输层 503 ×8，WARP-H2-LHR-84 出口正常（2a09:bac5:37ac:d2::15:33c）→ 仅记录
[15:41:52] ⚠ 传输层 503 ×11，同上                          ← 100 秒内 5 次，一次都没换线
[15:42:07] ⚠ 传输层 503 ×10，同上
```

**小请求能过、300KB 的大请求挂着** —— 探针判"出口正常"，asip 不换线，出口地址没变，
9router 的重放自然撞回同一个出口，再烧 20 秒。

首字节随请求体线性增长（同一出口实测）：

| 请求体 | 首字节 | 结果 |
|---|---|---|
| 5KB | 4.38s | 200 |
| 45KB | 4.64s | 200 |
| 131KB | 6.80s | 200 |
| 1000KB | 7.09s | 200 |
| 2000KB | 10.01s | 200 |
| 3600KB | 5.59s | 400（body 超限） |

真实请求体 p50 = 452KB、max 926KB（这个会话本身就 330–515KB），再叠并发排队，
20s 是踩在边上。成功记录的 TTFT 分布也印证这点：p50 6.4s、**p90 15.8s、p99 33.6s、
max 133s** —— "慢但会成功"是常态，不是异常。

补充：把"是不是大请求/并发"直接测了 —— 单发 324KB TTFB 6.26s 成功；5 并发
400KB 全部 200（6.1/6.3/6.5/7.0/12.3s）。所以**不是体积或并发的必然结果**，
是特定时间窗里出口对这类负载的排队。

### 9.4 改法：首次仍快判，只有重放放宽

| # | 文件 | 改动 |
|---|---|---|
| 1 | `config/runtimeConfig.js` | 新增 `headerTimeoutReplayMs`，默认 **45s**（env `OPENCODE_TRANSPORT_HEADER_TIMEOUT_REPLAY_MS`） |
| 2 | `utils/opencodeTransport.js` | 抽出 `resolveHeaderTimeoutMs(streamBody, replayBudget)`；非流式仍 0 |
| 3 | `executors/base.js` | `execute` 新增 `replayBudget` 形参，透传进 fetch options |
| 4 | `executors/opencode.js` | `retryOnceAfterStall` 重放时置 `replayBudget=true`，日志带预算秒数 |

口径边界（重要）：

- **首次尝试仍是 20s**，一条死出口照样快速判死 —— 不能因为这次改动让每条失败
  请求都白拖 45s。
- 45s 必须 < `FETCH_CONNECT_TIMEOUT_MS`(60s)，否则被 base 的 connectCtrl 先 abort，
  这个数字形同虚设。已写进测试。
- 非流式仍不设限（长生成可能在响应头返回前就超过任何固定值）。
- 只影响"传输层卡死后的那一次重放"，不影响 429 换线、不影响直连兜底。

### 9.5 上线与实测

构建 → 原子切换 → 门禁：

```
disk=X8BHoE9LvkUgW0PMVEuUL runtime=X8BHoE9LvkUgW0PMVEuUL MATCH
```

部署后 8 分钟（15:55:35–16:03）：

| 指标 | 修复前（15:20–15:55） | 修复后（15:55:35–16:03） |
|---|---|---|
| 请求 | 422（30 失败） | 135 完成 |
| `ERROR 503` | 13 | **0** |
| `header timeout` | 41 | **0** |
| 45s 预算重放触发 | — | 已见 `... with 45s header budget` |
| TTFT | p90 15.8s（历史窗口） | p50 7.95s / p90 13.1s / max 30.7s |
| 429 | 10（被 combo 吸收） | 9（同样被 combo 第 2 个模型吸收） |
| sing-box 重启 | — | 0（pid 7248 跨重启不变） |

注意最后一行：这次重启 9router 没有牵连底层 —— `KillMode=process` 的 drop-in
让 sing-box 留在原地，52 次隧道重启全是 asip 自己的配额轮换，与本次部署无关。

### 9.6 下一个该动的地方（有证据再动）

1. **asip 的"出口正常"判据**：`_opencode_lane_alive` 只打最小请求，永远看不见
   "大请求挂着"。合理做法是「transport 503 在 15s 窗口内累计 ≥N 且探针通过时，
   也换线」—— 符合主人「换 IP = 新配额」的判断。但这一轮**没动**：45s 预算可能
   已经把这类请求救回来了，先看数据再决定，避免无谓换线。
2. **7 条 `400`**：3.6MB body 直接 400，属于上游 body 上限，不是本链路的 bug。
3. **渠道锁**：当前 `channel_ban` 为空，41/57 条线有 IP，暂不构成瓶颈。

## 10. 第二轮：渠道块内修节点 + 5xx 退避 + 断流可观测（2026-11-09 17:55 上线）

主人定性：「502/断流这类节点延迟大、超时不可用，根子在落地节点，不是 429 配额、
也不是 colo 变化（同 colo）—— 正确动作是在**同一个渠道块内**换一个延迟好的可用
节点，而不是跨块换出口把流量切走。」错误驱动的换线保留，但换完之后要顺手把被切
下来的那条线修好，否则坏节点躺回候选池，下一轮又被选中再死一次（08:22–08:45
WG-1↔WG-9↔ICN-13 每 15~30s 弹跳正是这个模式）。

### 10.1 asip：换线后在渠道块内修复被切线（`daemon.py`）

- 新增 `_demoted_node_repair(old_tag, reason)`，由 `_after_warp_switch` 在换线成功
  后异步触发。触发条件 `_demoted_repair_applies(reason)`：只对节点级故障
  （`transport`）触发；`rate429` / `惩罚期` / `低质` / `主动轮换`一律不修
  （那些是 IP 或配额级，节点本身是好的）。
- H2：直接 `_h2_repair(member)`，selector 换同池节点，零重启、不断流。
- WG：同 colo 候选 = `colo_map` 里与当前节点同 colo 的节点，排除其他线已绑定的与
  `ban_backfill_node`，按 `_warp_alive_rank` → `_NODE_DELAYS` 升序取前 3 个，
  TCP 探测可达后 `_rehome_one` 写配置 + `_warp_line_restart(rebound=True)` 一次。
- 护栏：单飞 + 600s 冷却（`ASIP_DEMOTED_NODE_REPAIR_COOLDOWN`）；正在 refresh/
  prewarm 的线跳过；`stop_probe`（渠道锁判定换地址也买不到配额）跳过；开关
  `ASIP_DEMOTED_NODE_REPAIR`（默认 on）。
- `config.py` 新增 `demoted_node_repair_enabled` / `demoted_node_repair_cooldown_sec`。

### 10.2 9router：ERROR_RULES 补 502/503/504 退避（`open-sse/config/errorConfig.js`）

原先 `ERROR_RULES` 只有 401/402/403/404/429 状态规则，5xx 全落默认 30s transient
冷却。而中继的失败请求本身要跑 21–252s —— 冷却先到期，风暴期每个新请求都再撞一次
死中继（08:53 实测 90s 内 14 连 502）。给 502/503/504 加 `backoff: true` 后，连接级
路径（`auth.js`）会指数退避到 `BACKOFF_CONFIG.max`=5min；combo 路径每次仍
`backoffLevel=0` 立即切下一个模型，不受影响。

### 10.3 9router：sidecar 中途断流可观测（`scripts/opencode-transport.mjs`）

`return new Response(upstream.body, ...)` 路径上流死了原本零日志。包一层
`observeUpstreamBody`：用 reader 计已下发字节数，流中断 / 短读（字节数 ≠
content-length）时 `console.error` 一条（含 reqId、url、bytes/expected）。父进程
`opencodeTransport.js` 把 READY 之后的 sidecar stderr 按行 `console.error` 转发进
journal。reqId 通过 `tagWarnWithRequest` 给日志对象挂的非枚举属性
`opencodeRequestId` 传递，`fetchViaTransport` 的四参数签名与既有调用契约不变。

### 10.4 上线与实测

- asip：`systemctl restart auto-switch-ip.service`，pid 1414；sing-box 16 条线进程
  pid 全部 < 1414 未变（`KillMode=process` drop-in 生效）。重启后 20 分钟内已见 3 次
  `⇄ ... 换线后修复：已换同块节点（transport）`（SLC-15、SLC-14、TPE-7）。
- 9router：独立目录构建 → 原子切换 → `postdeploy_gate.sh strict` = MATCH
  （`disk=2YmW7xigR-gK2S8-d7vpq runtime=2YmW7xigR-gK2S8-d7vpq`）。
- 测试：asip `pytest 935 passed`；9router `vitest 4521 passed / 27 failed`
  （5 条基线外失败均在未改动模块 `proxy-redirect-hop-guard` / `cowork-mcp-redirect-hop`
  / `key-access-handlers` / `xquik-search-provider`，单独复现一致，与本次改动无代码路径交集）。

### 10.5 中继同步与仍不动的地方

两台中继已于 2026-11-09 19:48 前同步部署：
- 软路由（192.168.1.97:2222 → WSL Ubuntu）：asip 拉取重启（pid 1012733）；9router 拉取
  + 本地构建 + 原子切换，`nine-router-src.service` active，buildId `uQOnPm9YhIXyjhSI8ccMT`。
- VPS（hermes / 43.138.133.238）：asip 拉取重启（pid 1449890）；9router 源码 rsync + 本机
  `.next` 产物 rsync 到 `/opt/9router`（**不在 VPS 就地构建** —— ~4G 内存会 OOM，实测
  next build 把 SSH 打到 banner 超时 45min）。原子切换后
  `LC_ALL=C HEALTH_URL=http://127.0.0.1:38731/api/health postdeploy_gate.sh strict` = MATCH
  （`disk=2YmW7xigR-gK2S8-d7vpq runtime=2YmW7xigR-gK2S8-d7vpq`）。`LC_ALL=C` 是必须的：
  VPS locale 导致 `sort` 顺序与本机不同，会误报 STALE_SOURCE。

`_opencode_lane_alive` 的假阳性（小请求探针判「出口正常」）依旧未改 —— 45s 重放预算
+ 同块修节点已把这类请求的救回率拉上来，先看数据再决定是否要改成「累计 ≥N 也换线」。

### 10.6 上线后 2 小时审查观测（2026-11-09 17:55–20:00）

| 腿 | 502 | 503 | 429 | asip 同块修复 | 备注 |
|---|---|---|---|---|---|
| 本机 | 13（全在 VPS 宕机前/中，20:00 后 0）| 58（中间态）| 420 | 10 次 | combo 兜底成功 365 / DONE 360，无「所有模型失败」 |
| 软路由 | 0 | 0 | ~17 | 0 | 无 transport 故障，仅 429 |
| VPS | 0 | 15（中间态）| 13 | 5 次 | 无 trace，503 被 combo 吸收 |

- **502 已消除**：20:00 后本机 0；软路由/VPS 0。之前 13 条全是 252s 中继旧模式，
  集中在 VPS 宕机前/中，恢复后绝迹。
- **503 是 combo 中间态，不达客户端**：本机 503×58 全部被三模型轮转吸收
  （`Model ... succeeded` 365 次，`DONE` 360 次，无「所有模型失败」）。
- **asip 同块修节点生效**：修复的线没有在冷却内被重复选中（SLC-14 两次间隔 27min > 600s）。
- **sidecar 断流日志未触发**：ECONNRESET 全部发生在响应头之前（`upstream fetch failed`），
  不是中途断流；`observeUpstreamBody` 盲区已补，但暂无观测样本。
- **无回归**：三处 asip 0 Traceback；sing-box 进程稳定。
- **仍可观察的噪音**：本机 transport stall `header timeout` 51 次、`ECONNRESET` 44 次 →
  sidecar 重启 177 次/2h，都被 combo 吸收；429 高（420）是配额问题，非本次改动范围。

结论：三处上线后 502 清零、客户端零可见错误、asip 节点修复按设计工作。下一步若
transport stall 仍成串，再动 `_opencode_lane_alive` 假阳性。
