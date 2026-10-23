#!/bin/bash
# 修复9router_hermes 空返回问题 - 重启脚本
# 修改内容:
#   1. MAX_RETRIES 10→3（减少对不稳定上游的无效重试）
#   2. 激活 upstream circuit breaker（连续3次失败后快速失败）
#   3. 清空 bad_nodes.json（55个虚假 daemon_dead 条目）
#   4. daemon cleanup_dead_ttl 安全阀（Clash API不通不导出 + 全量死节点跳过导出）

set -e
cd /home/administrator

echo "=== 重启9router + auto-switch-ip ==="

echo "[1/4] 清空 bad_nodes.json"
echo '{}' > dkk-projects/auto-switch-ip/.bad_nodes.json
echo "  ✓ bad_nodes.json 已清空"

echo "[2/4] 重启 auto-switch-ip daemon (加载新安全阀)"
systemctl --user restart auto-switch-ip.service
sleep 2
systemctl --user is-active auto-switch-ip.service

echo "[3/4] 重启 nine-router (加载新 proxy-global.js)"
systemctl --user restart nine-router.service
sleep 3
systemctl --user is-active nine-router.service

echo "[4/4] 验证"
curl -s --max-time 5 http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 9router-local" \
  -d '{"model":"9router_hermes","messages":[{"role":"user","content":"say hi"}],"stream":true}' \
  | head -c 200

echo ""
echo "=== 完成 ==="
