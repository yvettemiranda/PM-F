#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/stop-$(date +%Y%m%d-%H%M%S).log"

{
  title "停止当前运行"
  print "会停止 Observe / Paper 的本地运行进程。不会影响任何真实资金，因为系统没有 Live 入口。"

  OBSERVE_PIDS="$(pgrep -f 'src/cli/observe-only\.ts' || true)"
  PAPER_PIDS="$(pgrep -f 'src/cli/paper-run\.ts' || true)"

  if [[ -z "$OBSERVE_PIDS$PAPER_PIDS" ]]; then
    print "没有发现正在运行的 Observe 或 Paper 进程。"
  else
    for pid in "${(@f)OBSERVE_PIDS}" "${(@f)PAPER_PIDS}"; do
      if [[ -n "$pid" ]]; then
        print "停止进程：$pid"
        kill -TERM "$pid" || true
      fi
    done
    print "已发送停止信号。请等待原运行窗口生成报告。"
  fi

  latest_files_hint
} 2>&1 | tee "$LOG_FILE"

pause_if_double_clicked
