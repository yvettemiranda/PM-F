#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/stop-$(date +%Y%m%d-%H%M%S).log"
operator_log_to "$LOG_FILE"

title "停止当前运行"
print "只会停止由本项目双击入口登记的 Observe / Paper 任务。"
print "不会扫描或停止其他项目，也不会影响任何真实资金。"

operator_stop_registered_sessions
if (( OPERATOR_SESSIONS_STOPPED == 0 )); then
  print "没有发现由本项目入口启动且仍在运行的任务。"
else
  print "已发送安全停止信号。原运行窗口会在写完报告后自行结束。"
fi

latest_files_hint
pause_if_double_clicked
