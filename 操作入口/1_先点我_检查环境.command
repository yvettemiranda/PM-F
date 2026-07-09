#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/check-$(date +%Y%m%d-%H%M%S).log"

{
  title "开始检查"
  ensure_ready

  title "当前代码版本"
  git --no-pager log -1 --oneline || true
  if [[ -n "$(git status --short)" ]]; then
    print "提示：当前工作区有未提交改动。可以运行，但确定性验收会把它记为 dirty。"
    git status --short
  else
    print "工作区干净。"
  fi

  title "类型检查"
  pnpm typecheck

  title "自动测试"
  pnpm test

  title "生成一次健康诊断报告"
  pnpm operational:validate -- --mode=health_monitor --duration-seconds=0

  title "检查完成"
  print "如果上面没有红色报错，下一步双击：2_开始Observe_24小时.command"
  latest_files_hint
} 2>&1 | tee "$LOG_FILE"

open_report_folders
pause_if_double_clicked

