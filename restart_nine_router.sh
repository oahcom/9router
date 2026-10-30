#!/bin/bash
# 9router 重启脚本（2026-10-30 第三版）。
#
# 真实部署：system 级 unit nine-router-src.service
#   WorkingDirectory=/home/administrator/9router
#   ExecStart=/opt/node-v22.23.4/bin/node custom-server.js --port 20127
#   Restart=always / RestartUSec=10s
# 所以这里只驱动 unit，不再自己 kill 进程再 setsid 起一个：脚本拉起的实例 systemd
# 不认，10s 后 unit 重启还会撞 EADDRINUSE，结果是「在跑的没人管、unit 进 failed」。
#
# 删掉的历史写法：systemctl --user（本机无该 unit）、cd 数据目录 .9router（无
# package.json）、setsid + npm run start（logs/ 不存在时静默失败却报「完成」）。
set -e

PORT=20127
REPO=/home/administrator/9router
cd "$REPO"

# system 级 unit 要 root。非 root 用 sudo -n —— 不带 -n 会在 polkit 上等交互、脚本
# 悄悄挂住。鉴权单独判：「没权限」和「单元起不来」是两回事，不能都报成需要 root。
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return 0
  fi
  if ! sudo -n true 2>/dev/null; then
    echo "  需要 root 权限：请用 sudo 运行本脚本（或用 root 账户），要执行的是：$*" >&2
    exit 1
  fi
  sudo -n "$@"
}

echo "=== 重启 9router（port $PORT） ==="

if systemctl list-unit-files 2>/dev/null | grep -q '^auto-switch-ip\.service'; then
  echo "[1/3] 重启 auto-switch-ip.service"
  # 这一条也是 system 级，同样要 root：之前直接调，非 root 在 polkit 上就断在这里，
  # 后面的 nine-router 根本没轮到（审查发现）。
  if ! as_root systemctl restart auto-switch-ip.service; then
    echo "  auto-switch-ip.service 重启失败" >&2
    systemctl status auto-switch-ip.service --no-pager -n 20 >&2 || true
    exit 1
  fi
  sleep 2
  systemctl is-active auto-switch-ip.service || true
else
  echo "[1/3] 跳过 auto-switch-ip.service（本机无该 unit）"
fi

echo "[2/3] 重启 nine-router-src.service"
mkdir -p logs
if ! as_root systemctl restart nine-router-src.service; then
  echo "  nine-router-src.service 重启失败（unit 起不来，不是权限问题）" >&2
  systemctl status nine-router-src.service --no-pager -n 20 >&2 || true
  exit 1
fi

for _ in $(seq 1 60); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " && break
  sleep 0.5
done
if ! ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "  启动失败：$PORT 没有在听（看 journalctl -u nine-router-src）" >&2
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
