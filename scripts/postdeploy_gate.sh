#!/bin/bash
# 把 check_deploy_state.sh 的三态（0 MATCH / 1 MISMATCH / 2 UNAVAILABLE）
# 映射成调用方该有的动作。原来的 `|| true` 把 1 和 2 一起吞掉，
# 「构建了没重启」于是永远静默 —— 产物里有修复、线上还是旧闸门，没人知道。
#
# 用法：
#   bash scripts/deploy_gate.sh          postbuild 语义：MISMATCH 是刚构建完的
#                                        正常状态，大声警告但不让构建失败
#   bash scripts/deploy_gate.sh strict   重启后语义：MISMATCH = 重启没生效，失败
#
# UNAVAILABLE 一律只警告：判不了不等于一致，但也不该让构建/重启卡死
# （服务恰好在构建窗口内停着，不是部署缺陷）。
bash "$(dirname "$0")/check_deploy_state.sh"
rc=$?
case "$rc" in
  0) exit 0 ;;
  1)
    if [ "${1:-}" = "strict" ]; then
      echo "✗ 部署态 MISMATCH —— 重启后运行构建与磁盘仍不一致" >&2
      exit 1
    fi
    echo "⚠ 部署态 MISMATCH：构建完成，但运行进程仍是旧构建 —— 需重启 9router" >&2
    ;;
  *)
    echo "⚠ 部署态 UNAVAILABLE(rc=$rc)：判不了（服务未起 / 读不到 BUILD_ID）" >&2
    ;;
esac
exit 0
