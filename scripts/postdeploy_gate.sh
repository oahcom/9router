#!/bin/bash
# 把 check_deploy_state.sh 的四态（0 MATCH / 1 MISMATCH / 2 UNAVAILABLE /
# 3 STALE_SOURCE）映射成调用方该有的动作。原来的 `|| true` 把 1 和 2 一起
# 吞掉，「构建了没重启」于是永远静默 —— 产物里有修复、线上还是旧闸门。
#
# 3 是后加的：disk/runtime 两侧同源于同一次构建，只能发现「构建了没重启」，
# 发现不了「改了源码没构建」（实测 cee3b16c / 3f25c8bf 都没进产物而门禁 MATCH）。
#
# 用法：
#   bash scripts/deploy_gate.sh          postbuild 语义：MISMATCH 是刚构建完的
#                                        正常状态，大声警告但不让构建失败
#   bash scripts/deploy_gate.sh strict   重启后语义：MISMATCH = 重启没生效，失败
#
# UNAVAILABLE 一律只警告：判不了不等于一致，但也不该让构建/重启卡死
# （服务恰好在构建窗口内停着，不是部署缺陷）。
# STALE_SOURCE 在 postbuild 下不可能出现（刚构建完产物必比源码新）；出现即说明
# 构建没有覆盖到这部分源码，strict 与非 strict 都按失败处理。
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
  3)
    echo "✗ 部署态 STALE_SOURCE —— 源码比产物新，这次构建没把改动带进产物" >&2
    exit 1
    ;;
  *)
    echo "⚠ 部署态 UNAVAILABLE(rc=$rc)：判不了（服务未起 / 读不到 BUILD_ID）" >&2
    ;;
esac
exit 0
