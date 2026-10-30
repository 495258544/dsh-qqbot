#!/bin/bash
# 安装/卸载「上游同步巡检」profile.d 兜底。
# 只做只读巡检，不合并代码；卸载即删 hook 文件，不影响插件内模块。
set -euo pipefail
HOOK=/etc/profile.d/98-upstream-watch.sh
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CLI="$REPO/lib/ops/cli.js"

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$HOOK"
    echo "已卸载 $HOOK"
    exit 0
fi

if [ ! -f "$CLI" ]; then
    echo "缺少 $CLI —— 先 npm run build" >&2
    exit 1
fi

cat > "$HOOK" <<EOF
# 上游同步巡检兜底常驻（proot 无 cron/systemd）。
# 插件内 setInterval 已覆盖主路径；这里保证"宿主没跑/插件被禁用"时巡检仍会发生。
# 两者共用同一 stateDir/.lock，不会重复巡检。
UW_CLI="$CLI"
if [ -f "\$UW_CLI" ]; then
    setsid nohup node "\$UW_CLI" --watch --notify=0 >/dev/null 2>&1 &
fi
EOF
chmod +x "$HOOK"
echo "已安装 $HOOK"
echo "验证: bash -n $HOOK && (新开会话后) ps -ef | grep -c '[c]li.js --watch'"
