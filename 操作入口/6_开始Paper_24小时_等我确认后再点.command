#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/paper-24h-$(date +%Y%m%d-%H%M%S).log"

{
  title "启动 Paper 24 小时"
  ensure_ready
  ensure_phase0_database

  print "注意：这个入口只做模拟交易，不会创建真实订单。"
  print "建议先把 24 小时 Observe 报告发给 Codex 分析，确认没问题后再运行本入口。"
  print ""
  print "运行时间：24 小时"
  print "循环间隔：1 秒"
  print "请保持这个窗口开着。"
  print ""

  pnpm paper:run -- --duration-seconds=86400 --interval-seconds=1

  title "Paper 运行已结束"
  latest_files_hint
} 2>&1 | tee "$LOG_FILE"

open_report_folders
pause_if_double_clicked

