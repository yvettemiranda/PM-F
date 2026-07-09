#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/observe-24h-$(date +%Y%m%d-%H%M%S).log"

{
  title "启动 Observe Only 24 小时"
  ensure_ready
  ensure_phase0_database

  print "目标钱包：$TARGET_WALLET"
  print "运行时间：24 小时"
  print "轮询间隔：15 秒"
  print ""
  print "请保持这个窗口开着。"
  print "需要提前停止时：在这个窗口按 Ctrl-C，或双击 3_停止当前运行.command"
  print ""

  pnpm observe:run -- "$TARGET_WALLET" --duration-seconds=86400 --poll-seconds=15

  title "Observe Only 已结束"
  latest_files_hint
} 2>&1 | tee "$LOG_FILE"

open_report_folders
pause_if_double_clicked

