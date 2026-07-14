#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/observe-24h-$(date +%Y%m%d-%H%M%S).log"
operator_log_to "$LOG_FILE"

title "启动 Observe Only 24 小时"
ensure_ready
ensure_phase0_database
operator_session_begin "observe" "$0"
trap 'operator_request_stop INT' INT
trap 'operator_request_stop TERM' TERM
trap 'operator_request_stop HUP' HUP
trap 'operator_cleanup' EXIT
operator_start_keep_awake

print "目标钱包：$TARGET_WALLET"
print "运行时间：24 小时"
print "轮询间隔：15 秒"
print ""
print "请保持这个窗口开着并保持电源、网络连接。"
print "可以锁屏或让屏幕自动变黑，但不要合上 MacBook 盖子，不要关机。"
print "需要提前停止时：在这个窗口按 Ctrl-C，或双击 3_停止当前运行.command"
print ""

operator_tsx "$PROJECT_ROOT/src/cli/observe-only.ts" "$TARGET_WALLET" \
  --duration-seconds=86400 --poll-seconds=15 &
OBSERVE_PID=$!
operator_track_child "$OBSERVE_PID"

OBSERVE_STATUS=0
operator_wait_child "$OBSERVE_PID" || OBSERVE_STATUS=$?
if (( OBSERVE_STATUS != 0 )); then
  print "Observe Only 异常结束（退出码 $OBSERVE_STATUS）。请把日志发给 Codex：$LOG_FILE"
  exit "$OBSERVE_STATUS"
fi

title "Observe Only 已结束"
latest_files_hint
open_report_folders
pause_if_double_clicked
