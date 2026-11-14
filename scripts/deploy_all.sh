#!/bin/bash
# 三端部署编排（2026-11-14）：本地 → push → 97 → zeus，每级部署后由
# scripts/verify_parity.sh 保质量与功能一致性（buildId/功能标记/daemon 版本）。
#
# 用法: bash scripts/deploy_all.sh [local|97|zeus ...]   # 默认三端全量
# 一致性契约：
#   - 只部署已提交代码：工作树有未提交改动直接拒绝（远端只能拿到 commit）
#   - 每端部署后 buildId 磁盘==运行态、零 429 功能标记在位、daemon 同版本
#   - 收尾 verify_parity 总表，退出码 = 阶段失败数 + 不一致端数
set -u
cd "$(dirname "$0")/.." || exit 2

TARGETS=${*:-"local 97 zeus"}
FAILED=0
DAEMON_LOCAL=/home/administrator/dkk-projects/auto-switch-ip

step() { echo; echo "##### $* #####"; }

# 一致性前提：部署=分发已提交代码。脏树会让本地构建≠远端构建。
for repo in "$PWD" "$DAEMON_LOCAL"; do
  if ! (cd "$repo" && git diff --quiet && git diff --cached --quiet); then
    echo "✗ $repo 工作树有未提交改动——先 commit 再部署（三端一致性要求远端拿到已提交代码）"
    exit 1
  fi
done

deploy_local() {
  step "本地 build + 重启（9router + auto-switch-ip）"
  npm run build 2>&1 | tail -2
  bash scripts/restart_nine_router.sh 2>&1 | tail -5 || FAILED=$((FAILED + 1))
}

push_all() {
  step "推送 git（9router master-oa / daemon main）"
  git push origin master-oa 2>&1 | tail -1
  (cd "$DAEMON_LOCAL" && git push origin HEAD 2>&1 | tail -1)
}

deploy_remote() {
  local name="$1" host="$2" gitdir="$3" runtime="$4" daemon="$5" extra="$6"
  step "[$name] 9router 更新 + 构建 + 重启"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "
    set -e
    cd $gitdir
    git stash -u >/dev/null 2>&1 || true
    git fetch origin master-oa 2>&1 | tail -1
    git checkout -B master-oa origin/master-oa 2>&1 | tail -1
    git log --oneline -1 | cut -c1-58
    npm run build 2>&1 | tail -2
    $extra
    sudo -n systemctl restart nine-router-src
    sleep 3
    systemctl is-active nine-router-src
  " || FAILED=$((FAILED + 1))
  step "[$name] daemon 更新 + 重启"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "
    set -e
    cd $daemon
    git stash -u >/dev/null 2>&1 || true
    git fetch origin main 2>&1 | tail -1
    git checkout -B main origin/main 2>&1 | tail -1
    git log --oneline -1 | cut -c1-58
    sudo -n systemctl restart auto-switch-ip
    sleep 2
    systemctl is-active auto-switch-ip
  " || FAILED=$((FAILED + 1))
}

case " $TARGETS " in *" local "*) deploy_local ;; esac
push_all
case " $TARGETS " in
  *" 97 "*) deploy_remote "97" "administrator@192.168.1.97" \
    "/home/administrator/9router" "/home/administrator/9router" \
    "/home/administrator/auto-swicth-ip" "" ;;
esac
case " $TARGETS " in
  *" zeus "*) deploy_remote "zeus" "hermes" \
    "/home/ubuntu/9router" "/opt/9router" \
    "/home/ubuntu/auto-swicth-ip" \
    "sudo -n rsync -a --delete --exclude .git /home/ubuntu/9router/ /opt/9router/ && echo [sync] ok" ;;
esac

step "三端一致性验证"
bash scripts/verify_parity.sh
P=$?
echo
if [ "$FAILED" -eq 0 ] && [ "$P" -eq 0 ]; then
  echo "== 部署完成：三端一致 =="
else
  echo "== 部署有问题：阶段失败=$FAILED 不一致端=$P =="
fi
exit $((FAILED + P))
