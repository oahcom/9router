#!/bin/bash
# 三端一致性验证（2026-11-14）：本地 / 97 / zeus 的构建身份与功能标记对齐检查。
#
# 校验项（每端）：
#   1. 9router git 提交号与本地一致（代码同一版本）
#   2. 磁盘 .next/BUILD_ID == 运行态 /api/health 的 buildId（构建即运行）
#   3. 零 429 功能标记在构建产物中（"no sacrifice" / "2nd strike reported"）
#   4. daemon 提交号一致 + 渠道延迟接线在位（_channel_latency_ms）
#   5. nine-router-src / auto-switch-ip 均 active
# 任一不符该端 FAIL，退出码=不一致端数。部署后跑它 = 部署质量门禁。
# 用法: bash scripts/verify_parity.sh
set -u
cd "$(dirname "$0")/.." || exit 2
# 短 SHA 长度按仓库对象数自适应，两端可能差一截（zeus 7 位 vs 本地 8 位）——
# 一律用全长 SHA 比较，显示才截短。
LOCAL_SHA=$(git rev-parse HEAD)
LOCAL_DAEMON_SHA=$(cd /home/administrator/dkk-projects/auto-switch-ip 2>/dev/null && git rev-parse HEAD)
echo "== 本地基准: 9router=${LOCAL_SHA:0:8} daemon=${LOCAL_DAEMON_SHA:0:8} =="

FAILS=0

check_local() {
  local build rt m1 m2 ok=1
  build=$(cat .next/BUILD_ID 2>/dev/null)
  rt=$(curl -s --max-time 8 http://127.0.0.1:20127/api/health | grep -oE 'buildId":"[^"]+' | cut -d'"' -f3)
  m1=$(grep -rl 'no sacrifice' .next 2>/dev/null | grep -v node_modules | head -1)
  m2=$(grep -rl '2nd strike reported' .next 2>/dev/null | grep -v node_modules | head -1)
  [ -n "$build" ] && [ "$build" = "$rt" ] || { echo "  ✗ buildId 磁盘=$build 运行态=$rt"; ok=0; }
  [ -n "$m1" ] || { echo "  ✗ 标记 no-sacrifice 缺失"; ok=0; }
  [ -n "$m2" ] || { echo "  ✗ 标记 2nd-strike 缺失"; ok=0; }
  if [ "$ok" = 1 ]; then echo "✓ 本地 一致 (build=$build)"
  else echo "✗ 本地 不一致"; FAILS=$((FAILS + 1)); fi
}

check_remote() {
  local name="$1" host="$2" gitdir="$3" runtime="$4" daemon="$5"
  local out ok=1 sha build rt m1 m2 dsha dref svcs
  out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "
    cd $gitdir && echo SHA=\$(git rev-parse HEAD)
    echo BUILD=\$(cat $runtime/.next/BUILD_ID 2>/dev/null)
    pid=\$(systemctl show -p MainPID nine-router-src | cut -d= -f2)
    port=\$(ss -ltnp 2>/dev/null | grep \"pid=\$pid,\" | grep -oE ':[0-9]{4,5}' | head -1 | tr -d ':')
    echo RT=\$(curl -s --max-time 8 \"http://127.0.0.1:\${port:-20127}/api/health\" | grep -oE 'buildId\":\"[^\"]+' | cut -d'\"' -f3)
    echo M1=\$(grep -rl 'no sacrifice' $runtime 2>/dev/null | grep -v node_modules | head -1)
    echo M2=\$(grep -rl '2nd strike reported' $runtime 2>/dev/null | grep -v node_modules | head -1)
    cd $daemon && echo DSHA=\$(git rev-parse HEAD)
    echo DREF=\$(grep -c '_channel_latency_ms' $daemon/daemon.py 2>/dev/null)
    echo SVCS=\$(systemctl is-active nine-router-src)/\$(systemctl is-active auto-switch-ip)
  " 2>&1)
  sha=$(echo "$out" | grep -oE '^SHA=[0-9a-f]+' | cut -d= -f2)
  build=$(echo "$out" | grep -oE '^BUILD=[^ ]*' | cut -d= -f2)
  rt=$(echo "$out" | grep -oE '^RT=[^ ]*' | cut -d= -f2)
  m1=$(echo "$out" | grep -oE '^M1=[^ ]*' | cut -d= -f2)
  m2=$(echo "$out" | grep -oE '^M2=[^ ]*' | cut -d= -f2)
  dsha=$(echo "$out" | grep -oE '^DSHA=[0-9a-f]+' | cut -d= -f2)
  dref=$(echo "$out" | grep -oE '^DREF=[0-9]+' | cut -d= -f2)
  svcs=$(echo "$out" | grep -oE '^SVCS=[^ ]*' | cut -d= -f2)
  [ "$sha" = "$LOCAL_SHA" ] || { echo "  ✗ git $sha != $LOCAL_SHA"; ok=0; }
  [ -n "$build" ] && [ "$build" = "$rt" ] || { echo "  ✗ buildId 磁盘=$build 运行态=$rt"; ok=0; }
  [ -n "$m1" ] || { echo "  ✗ 标记 no-sacrifice 缺失"; ok=0; }
  [ -n "$m2" ] || { echo "  ✗ 标记 2nd-strike 缺失"; ok=0; }
  [ "$dsha" = "$LOCAL_DAEMON_SHA" ] || { echo "  ✗ daemon $dsha != $LOCAL_DAEMON_SHA"; ok=0; }
  [ "${dref:-0}" -ge 1 ] || { echo "  ✗ daemon 渠道延迟未接线"; ok=0; }
  [ "$svcs" = "active/active" ] || { echo "  ✗ 服务状态 $svcs"; ok=0; }
  if [ "$ok" = 1 ]; then
    echo "✓ $name 一致 (9router=$sha build=$build daemon=$dsha)"
  else
    echo "✗ $name 不一致"
    FAILS=$((FAILS + 1))
  fi
}

check_local
check_remote "97" "administrator@192.168.1.97" "/home/administrator/9router" "/home/administrator/9router" "/home/administrator/auto-swicth-ip"
check_remote "zeus" "hermes" "/home/ubuntu/9router" "/opt/9router" "/home/ubuntu/auto-swicth-ip"

echo "== 汇总: $([ "$FAILS" -eq 0 ] && echo 全部一致 || echo "$FAILS 端不一致") =="
exit "$FAILS"
