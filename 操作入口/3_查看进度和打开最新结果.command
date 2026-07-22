#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"
cd "$PROJECT_ROOT"

title "Paper 累计验证进度"
node --import tsx "$PROJECT_ROOT/src/cli/paper-campaign-status.ts" \
  --target-wallet="$TARGET_WALLET" || true

latest_result="$(operator_latest_campaign_result 2>/dev/null || true)"
if [[ -n "$latest_result" && -e "$latest_result" ]]; then
  print ""
  print "最新一次生成的结果："
  print "$latest_result"
  open -R "$latest_result" 2>/dev/null || true
else
  print "还没有累计验证结果。完成或安全暂停一次后会自动生成。"
  mkdir -p "$PROJECT_ROOT/交给Codex"
  open "$PROJECT_ROOT/交给Codex" 2>/dev/null || true
fi
pause_if_double_clicked
