#!/bin/bash
# 部署态自检：比对磁盘上的构建标识与运行进程报告的构建标识。
#
# 为什么需要它：npm run build 只换磁盘文件，不换正在跑的进程。没有这道比对，
# 「构建完成了」和「新构建生效了」在外部看来完全一样，于是会出现「产物里有修复、
# 线上仍是旧闸门」这种沉默态。
#
# 判据来源刻意选 BUILD_ID 双方比对，而不是「进程启动时刻 vs 产物 mtime」：
# 本机（WSL2）用 /proc/stat 的 btime 反推进程启动时刻会漂，同一 pid 三次读数
# 得到 10:04 / 11:07 / 12:04，那条判据不可用。buildId 是常量字符串，不依赖时钟。
#
# 退出码：
#   0  MATCH        磁盘与运行一致，且产物不比源码旧
#   1  MISMATCH     构建了但没重启（或运行的是别的构建）
#   2  UNAVAILABLE  判不了（读不到磁盘 BUILD_ID / 连不上服务 / 服务没报 buildId）
#                   —— 连不上绝不能当「一致」返回 0。
#   3  STALE_SOURCE 运行时源码比产物新 —— 改了代码没构建。disk/runtime 两侧都取自
#                   同一次构建，因此对这一类**结构上看不见**（实测 cee3b16c 与
#                   3f25c8bf 都不在产物里，而门禁报 MATCH）。
#
# 可用环境变量覆盖：NEXT_DIST_DIR（默认 .next）、HEALTH_URL。

cd "$(dirname "$0")/.." || exit 2

DIST_DIR="${NEXT_DIST_DIR:-.next}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:20127/api/health}"

disk=$(tr -d '[:space:]' < "$DIST_DIR/BUILD_ID" 2>/dev/null)
if [ -z "$disk" ]; then
  echo "UNAVAILABLE disk BUILD_ID unreadable: $DIST_DIR/BUILD_ID"
  exit 2
fi

body=$(curl -s -m 3 "$HEALTH_URL" 2>/dev/null)
if [ -z "$body" ]; then
  echo "UNAVAILABLE cannot reach $HEALTH_URL"
  exit 2
fi

runtime=$(printf '%s' "$body" | jq -r '.buildId // empty' 2>/dev/null)
if [ -z "$runtime" ]; then
  echo "UNAVAILABLE runtime did not report buildId (endpoint predates this check): $body"
  exit 2
fi

if [ "$disk" != "$runtime" ]; then
  echo "disk=$disk runtime=$runtime MISMATCH"
  exit 1
fi

# 第三路输入：产物是否对应**当前**源码内容。BUILD_ID 两侧同源于同一次构建，
# 只能发现「构建了没重启」，发现不了「改了源码没构建」—— 实测 cee3b16c(跨源剥凭据)
# 与 3f25c8bf(health 启动钉住) 都不在产物里而这条命令报 MATCH。
#
# 判据用内容哈希，不用 mtime、也不用提交时间：两者都能合法地与事实相反
# （touch 不改内容会推新 mtime；先构建后提交会让提交时间晚于产物，而产物其实已含该改动）。
# 构建时由 postbuild 写入 .next/SOURCE_STAMP，这里重算并比对。
runtime_paths="src open-sse next.config.js next.config.mjs package.json"

source_stamp() {
  find $runtime_paths -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) \
       -not -path '*/node_modules/*' -print0 2>/dev/null \
    | sort -z \
    | xargs -0 -r sha256sum 2>/dev/null \
    | sha256sum | cut -d' ' -f1
}

stamp_file="$DIST_DIR/SOURCE_STAMP"
if [ ! -f "$stamp_file" ]; then
  echo "disk=$disk runtime=$runtime UNAVAILABLE 产物未记录源码戳（构建早于本判据）: $stamp_file"
  exit 2
fi

built=$(tr -d '[:space:]' < "$stamp_file")
current=$(source_stamp)
if [ "$built" != "$current" ]; then
  echo "disk=$disk runtime=$runtime STALE_SOURCE —— 运行时代码与产物不符，需重新构建："
  echo "  built=$built current=$current"
  dirty=$(git status --porcelain -- $runtime_paths 2>/dev/null | head -5)
  [ -n "$dirty" ] && printf '  未提交：%s\n' "$dirty"
  git log -1 --format='  最近提交：%h %cI %s' -- $runtime_paths 2>/dev/null
  exit 3
fi

echo "disk=$disk runtime=$runtime MATCH"
exit 0
