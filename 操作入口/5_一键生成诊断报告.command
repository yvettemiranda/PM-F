#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/diagnostics-$(date +%Y%m%d-%H%M%S).log"

{
  title "生成诊断报告"
  ensure_ready
  ensure_phase0_database

  DIAGNOSTIC_STATUS=0

  title "Final Validation 报告"
  pnpm validate:final -- --type=all || DIAGNOSTIC_STATUS=1

  title "Operational Health 报告"
  pnpm operational:validate -- --mode=health_monitor --duration-seconds=0 || DIAGNOSTIC_STATUS=1

  title "Operational Crash Recovery 报告"
  pnpm operational:validate -- --mode=crash_recovery --duration-seconds=0 || DIAGNOSTIC_STATUS=1

  title "诊断完成"
  print "请把最新生成的 validation-report.json、operational-report.json，或者整个 data 文件夹里的相关报告发给 Codex。"
  latest_files_hint
  if (( DIAGNOSTIC_STATUS != 0 )); then
    print "诊断发现阻断项或失败项。这不是 Live 已开启；请把报告发给 Codex 分析。"
  fi
} 2>&1 | tee "$LOG_FILE"

open_report_folders
pause_if_double_clicked
