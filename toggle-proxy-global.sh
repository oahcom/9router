#!/bin/bash
# proxy-global.js + nine-router.service 统一开关
#
# 两套逻辑:
#   on  = 完整栈 (nine-router.service + proxy-global.js 全部功能)
#   off = 精简栈 (nine-router.service 运行，但 proxy-global.js 跳过所有 monkey-patch)
#
# proxy-global.js 头部检查 ~/.9router/proxy-global.disabled 文件
# 文件存在 → return 跳过所有 patch → 9router 原生运行
#
# 用法:
#   ./toggle-proxy-global.sh on     # 开启 proxy-global.js 全部功能
#   ./toggle-proxy-global.sh off    # 关闭 proxy-global.js (9router 仍运行)
#   ./toggle-proxy-global.sh status # 查看状态

DISABLED_FILE="$HOME/.9router/proxy-global.disabled"

case "$1" in
  off)
    # 标记 proxy-global.js 禁用
    touch "$DISABLED_FILE"
    echo "proxy-global.js → DISABLED (monkey-patch 跳过)"

    # 重启 nine-router.service 使生效
    systemctl --user restart nine-router 2>/dev/null
    echo "nine-router.service → RESTARTED"
    ;;
  on)
    # 移除禁用标记
    rm -f "$DISABLED_FILE"
    echo "proxy-global.js → ENABLED (monkey-patch 生效)"

    # 重启 nine-router.service 使生效
    systemctl --user restart nine-router 2>/dev/null
    echo "nine-router.service → RESTARTED"
    ;;
  status)
    echo "nine-router.service: $(systemctl --user is-active nine-router 2>/dev/null || echo inactive)"
    if [ -f "$DISABLED_FILE" ]; then
      echo "proxy-global.js:     DISABLED (monkey-patch 跳过)"
    else
      echo "proxy-global.js:     ENABLED (monkey-patch 生效)"
    fi
    ;;
  *)
    echo "用法: $0 {off|on|status}"
    echo ""
    echo "  off    — 关闭 proxy-global.js (9router 仍运行，无 monkey-patch)"
    echo "  on     — 开启 proxy-global.js (完整功能)"
    echo "  status — 查看状态"
    exit 1
    ;;
esac
