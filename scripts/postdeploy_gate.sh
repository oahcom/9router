#!/bin/bash
# 把 check_deploy_state.sh 的四态（0 MATCH / 1 MISMATCH / 2 UNAVAILABLE /
# 3 STALE_SOURCE）映射成调用方该有的动作。原来的 `|| true` 把 1 和 2 一起
# 吞掉，「构建了没重启」于是永远静默 —— 产物里有修复、线上还是旧闸门。
#
# 3 是后加的：disk/runtime 两侧同源于同一次构建，只能发现「构建了没重启」，
# 发现不了「改了源码没构建」（实测 cee3b16c / 3f25c8bf 都没进产物而门禁 MATCH）。
#
# 用法：
#   bash scripts/deploy_gate.sh postbuild  postbuild 语义：MISMATCH 是刚构建完的
#                                        正常状态，大声警告但不让构建失败；
#                                        此模式先写下源码戳 .next/SOURCE_STAMP
#   bash scripts/deploy_gate.sh strict   重启后语义：MISMATCH = 重启没生效，失败
#   bash scripts/deploy_gate.sh          只读查状态。**不写戳**
#
# 模式必须显式给：无参写戳等于把「此刻的源码」当成「已构建的源码」，
# 任何一次人工查状态都会把第三路输入投毒成 MATCH（实测：改过源码未构建，
# 无参跑一次即报 MATCH，之后 strict 再也发现不了）。
#
# UNAVAILABLE 一律只警告：判不了不等于一致，但也不该让构建/重启卡死
# （服务恰好在构建窗口内停着，不是部署缺陷）。
runtime_paths="src open-sse next.config.js next.config.mjs package.json"

if [ "${1:-}" = "postbuild" ]; then
  # 产物已就位，把「这次构建覆盖的源码内容」记进 dist 目录，供 check_deploy_state
  # 在每次启动后比对。内容哈希而非 mtime：mtime 会被 touch 推新而与内容脱节。
  NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next}"
  if [ -d "$NEXT_DIST_DIR" ]; then
    find $runtime_paths -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) \
         -not -path '*/node_modules/*' -print0 2>/dev/null \
      | sort -z | xargs -0 -r sha256sum 2>/dev/null \
      | sha256sum | cut -d' ' -f1 > "$NEXT_DIST_DIR/SOURCE_STAMP"
  fi
fi

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
    # postbuild 里出现 3 = 构建期间源码又被改了（或本就该重建），只警告；
    # strict 里出现 3 = 这次重启服务的仍是旧代码，失败。
    if [ "${1:-}" = "strict" ]; then
      echo "✗ 部署态 STALE_SOURCE —— 源码比产物新，这次重启跑的是旧代码" >&2
      exit 1
    fi
    echo "⚠ 部署态 STALE_SOURCE —— 源码比产物新，构建期间源码被改动？" >&2
    ;;
  *)
    echo "⚠ 部署态 UNAVAILABLE(rc=$rc)：判不了（服务未起 / 读不到 BUILD_ID）" >&2
    ;;
esac
exit 0
