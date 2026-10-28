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
cd /home/administrator/.9router

echo "=== 重启 9router（port $PORT） ==="

if systemctl --user list-unit-files 2>/dev/null | grep -q '^auto-switch-ip\.service'; then
  echo "[1/3] 重启 auto-switch-ip.service"
  systemctl --user restart auto-switch-ip.service
  sleep 2
  systemctl --user is-active auto-switch-ip.service
else
  echo "[1/3] 跳过 auto-switch-ip.service（本机无该 unit）"
fi

echo "[2/3] 重启 9router 进程"
OLD_PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLD_PID:-}" ]; then
  echo "  kill $OLD_PID"
  kill "$OLD_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    ss -ltn 2>/dev/null | grep -q ":$PORT " || break
    sleep 0.5
  done
fi
LOG="logs/start-$(date +%Y%m%d-%H%M).log"
setsid nohup npm run start > "$LOG" 2>&1 &
for _ in $(seq 1 60); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " && break
  sleep 0.5
done
echo "  日志: $LOG"

echo "[3/3] 验证"
curl -s -o /dev/null -w "  /v1/models HTTP=%{http_code} t=%{time_total}s\n" --max-time 10 \
  "http://127.0.0.1:$PORT/v1/models" \
  -H "Authorization: Bearer ${HERMES_ROUTER_KEY:-9router-local}"

echo "=== 完成 ==="
