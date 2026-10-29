#!/bin/bash
# 9router 重启脚本。
#
# 2026-10-28 校正：这里原来 `systemctl --user restart nine-router.service`，
# 但 nine-router.service 与 auto-switch-ip.service 在本机都不存在（both inactive，
# 无 unit 文件），脚本在 set -e 下第一条 restart 就中断，且探活还打在已废弃的
# 20128 端口。9router 的真实运行方式是 setsid + npm run start（custom-server.js）。
# 现在按真实进程管理重写：只有确实存在 unit 时才走 systemctl。
set -e

PORT=20127
# 真实部署是 system 级 nine-router-src.service（WorkingDirectory 是仓库根，
# ExecStart=custom-server.js）。之前 cd 到数据目录 .9router，那里没有 package.json，
# 照这个脚本重启就是先 kill 再起不来（审查发现）。
cd /home/administrator/9router

echo "=== 重启 9router（port $PORT） ==="

if systemctl list-unit-files 2>/dev/null | grep -q '^auto-switch-ip\.service'; then
  echo "[1/3] 重启 auto-switch-ip.service"
  systemctl restart auto-switch-ip.service
  sleep 2
  systemctl is-active auto-switch-ip.service
else
  echo "[1/3] 跳过 auto-switch-ip.service（本机无该 unit）"
fi

echo "[2/3] 重启 nine-router-src.service（system 级 unit）"
# 不在这里 kill 端口上的进程再自己 setsid 起一个：真实部署由 unit 管，
# 脚本拉起的实例 systemd 不认，10s 后 Restart=always 还会撞 EADDRINUSE，
# 结果是「在跑的进程没人管、unit 进 failed」。
mkdir -p logs
systemctl restart nine-router-src.service

for _ in $(seq 1 60); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " && break
  sleep 0.5
done
if ! ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "  启动失败：$PORT 没有在听（unit 起不来的话，日志在 journalctl -u nine-router-src）" >&2
  systemctl status nine-router-src.service --no-pager -n 20 >&2 || true
  exit 1
fi
echo "  systemctl is-active: $(systemctl is-active nine-router-src.service)"

echo "[3/3] 验证"
# 探活要判结果：原来 curl 的退出码没人看，服务没起来也打印「完成」。
KEY=$HERMES_ROUTER_KEY
[ -n "$KEY" ] || KEY=9router-local
if ! curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:$PORT/v1/models" -H "Authorization: Bearer $KEY"; then
  echo "  探活失败：/v1/models 没回 2xx" >&2
  exit 1
fi
echo "  /v1/models OK"

echo "=== 完成 ==="
