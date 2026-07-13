#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/paper-24h-$(date +%Y%m%d-%H%M%S).log"
READY_FILE="$RUN_DIR/paper-ready.json"
operator_log_to "$LOG_FILE"

title "启动 Paper + Observe 24 小时"
ensure_ready
ensure_phase0_database
operator_session_begin "paper" "$0"
trap 'operator_request_stop INT' INT
trap 'operator_request_stop TERM' TERM
trap 'operator_request_stop HUP' HUP
trap 'operator_cleanup' EXIT
operator_start_keep_awake
rm -f "$READY_FILE"

print "注意：这个入口只做模拟交易和公开数据监控，不会创建真实订单。"
print "系统会先恢复同一个 Paper 账户和消费游标，再启动 Observe 产生新 Signal。"
print "运行时间：24 小时"
print "Paper 循环间隔：1 秒；Observe 轮询间隔：15 秒"
print "请保持这个窗口开着；屏幕可以关闭，电脑不要关机。"
print ""

operator_tsx "$PROJECT_ROOT/src/cli/paper-run.ts" \
  --duration-seconds=86400 \
  --interval-seconds=1 \
  --account-id-file="$PAPER_ACCOUNT_ID_FILE" \
  --ready-file="$READY_FILE" &
PAPER_PID=$!
operator_track_child "$PAPER_PID"

ready_attempt=0
while [[ ! -s "$READY_FILE" ]] && operator_process_running "$PAPER_PID" && (( ready_attempt < 300 )); do
  sleep 0.1
  (( ready_attempt += 1 ))
done
if [[ ! -s "$READY_FILE" ]]; then
  print "Paper 未能在 30 秒内完成账户恢复，Observe 不会启动。"
  operator_request_stop READY_TIMEOUT
  operator_wait_child "$PAPER_PID" || true
  exit 1
fi
print "Paper 已准备好：$(tr -d '\n' < "$PAPER_ACCOUNT_ID_FILE")"

operator_tsx "$PROJECT_ROOT/src/cli/observe-only.ts" "$TARGET_WALLET" \
  --duration-seconds=86400 --poll-seconds=15 &
OBSERVE_PID=$!
operator_track_child "$OBSERVE_PID"
print "Observe 已启动；现在开始模拟闭环验证。"

while operator_process_running "$PAPER_PID" && operator_process_running "$OBSERVE_PID"; do
  sleep 1
done

operator_request_stop COMPANION_COMPLETED

PAPER_STATUS=0
OBSERVE_STATUS=0
operator_wait_child "$PAPER_PID" || PAPER_STATUS=$?
operator_wait_child "$OBSERVE_PID" || OBSERVE_STATUS=$?

if (( PAPER_STATUS != 0 || OBSERVE_STATUS != 0 )); then
  print "Paper 验证异常结束（Paper=$PAPER_STATUS, Observe=$OBSERVE_STATUS）。"
  print "请把日志发给 Codex：$LOG_FILE"
  exit 1
fi

title "Paper + Observe 运行已结束"
latest_files_hint
open_report_folders
pause_if_double_clicked
