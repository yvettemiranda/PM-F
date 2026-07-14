#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

LOG_FILE="$LOG_DIR/paper-24h-$(date +%Y%m%d-%H%M%S)-$$.log"
READY_FILE="$RUN_DIR/paper-ready.json"
RESULT_MARKER="$RUN_DIR/paper-24h-results-$$.marker"
RESULT_PACKAGED=0
RUN_STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S %z')"
PAPER_STATUS="NOT_STARTED"
OBSERVE_STATUS="NOT_STARTED"

title "启动 Paper + Observe 24 小时"
if ! operator_session_begin "paper" "$0"; then
  print "本次没有启动新任务，也不会生成新结果包。"
  pause_if_double_clicked
  exit 1
fi
trap 'operator_cleanup' EXIT

operator_managed_log_to "$LOG_FILE"
: > "$RESULT_MARKER"

finalize_combined_validation() {
  local original_status="${1:-0}"
  trap - EXIT INT TERM HUP
  operator_cleanup || true
  operator_finish_managed_log || true
  if (( RESULT_PACKAGED == 0 )); then
    operator_create_codex_bundle \
      "$RESULT_MARKER" \
      "$LOG_FILE" \
      "Paper + Observe 24 小时联合验证" \
      "$PAPER_STATUS" \
      "$OBSERVE_STATUS" \
      "$RUN_STARTED_AT" || true
    RESULT_PACKAGED=1
  fi
  rm -f "$RESULT_MARKER"
  reveal_codex_result
  return "$original_status"
}
trap 'finalize_combined_validation $?' EXIT
trap 'operator_request_stop INT' INT
trap 'operator_request_stop TERM' TERM
trap 'operator_request_stop HUP' HUP

ensure_ready
ensure_phase0_database
if (( OPERATOR_STOP_REQUESTED == 1 )); then
  PAPER_STATUS="STOPPED_BEFORE_START"
  OBSERVE_STATUS="STOPPED_BEFORE_START"
  print "24 小时验证已在启动准备阶段停止。"
  exit 130
fi
operator_start_keep_awake
rm -f "$READY_FILE"

print "注意：这个入口只做模拟交易和公开数据监控，不会创建真实订单。"
print "系统会先恢复同一个 Paper 账户和消费游标，再启动 Observe 产生新 Signal。"
print "运行时间：Observe 满 24 小时后自动结束"
print "Paper 循环间隔：1 秒；Observe 轮询间隔：15 秒"
print "请保持这个窗口开着并保持电源、网络连接。"
print "可以锁屏或让屏幕自动变黑，但不要合上 MacBook 盖子，不要关机。"
print ""

operator_tsx "$PROJECT_ROOT/src/cli/paper-run.ts" \
  --duration-seconds=0 \
  --interval-seconds=1 \
  --account-id-file="$PAPER_ACCOUNT_ID_FILE" \
  --ready-file="$READY_FILE" &
PAPER_PID=$!
PAPER_STATUS="RUNNING"
operator_track_child "$PAPER_PID"

ready_attempt=0
while [[ ! -s "$READY_FILE" ]] \
  && operator_process_running "$PAPER_PID" \
  && (( OPERATOR_STOP_REQUESTED == 0 && ready_attempt < 300 )); do
  sleep 0.1
  (( ready_attempt += 1 ))
done
if (( OPERATOR_STOP_REQUESTED == 1 )); then
  operator_request_stop STARTUP_CANCELLED
  operator_wait_child "$PAPER_PID" stopping || true
  PAPER_STATUS="STOPPED_EARLY"
  OBSERVE_STATUS="NOT_STARTED"
  print "24 小时验证已在 Paper 启动阶段提前停止。"
  exit 130
fi
if [[ ! -s "$READY_FILE" ]]; then
  print "Paper 未能在 30 秒内完成账户恢复，Observe 不会启动。"
  operator_request_stop READY_TIMEOUT
  operator_wait_child "$PAPER_PID" stopping || true
  PAPER_STATUS="STOPPED_READY_TIMEOUT"
  exit 1
fi
print "Paper 已准备好：$(tr -d '\n' < "$PAPER_ACCOUNT_ID_FILE")"

if (( OPERATOR_STOP_REQUESTED == 1 )); then
  operator_request_stop STARTUP_CANCELLED
  operator_wait_child "$PAPER_PID" stopping || true
  PAPER_STATUS="STOPPED_EARLY"
  OBSERVE_STATUS="NOT_STARTED"
  print "24 小时验证已在 Observe 启动前停止。"
  exit 130
fi

operator_tsx "$PROJECT_ROOT/src/cli/observe-only.ts" "$TARGET_WALLET" \
  --duration-seconds=86400 --poll-seconds=15 &
OBSERVE_PID=$!
OBSERVE_STATUS="RUNNING"
operator_track_child "$OBSERVE_PID"
print "Observe 已启动；现在开始模拟闭环验证。"

if (( OPERATOR_STOP_REQUESTED == 1 )); then
  operator_request_stop STARTUP_CANCELLED
fi

while (( OPERATOR_STOP_REQUESTED == 0 )) \
  && operator_process_running "$PAPER_PID" \
  && operator_process_running "$OBSERVE_PID"; do
  sleep 1
done

PAPER_EXIT_CODE=0
OBSERVE_EXIT_CODE=0

if (( OPERATOR_STOP_REQUESTED == 1 )); then
  operator_wait_child "$PAPER_PID" stopping || true
  operator_wait_child "$OBSERVE_PID" stopping || true
  PAPER_STATUS="STOPPED_EARLY"
  OBSERVE_STATUS="STOPPED_EARLY"
  print "24 小时验证已提前停止。"
  print "系统正在整理已有结果；随后请把 Finder 中选中的 ZIP 发给 Codex。"
  exit 130
fi

if ! operator_process_running "$OBSERVE_PID"; then
  operator_wait_child "$OBSERVE_PID" || OBSERVE_EXIT_CODE=$?
  OBSERVE_REPORT="$(operator_latest_result_since "$PROJECT_ROOT/data/observe" 'observe-*.json' "$RESULT_MARKER" || true)"
  OBSERVE_ACCEPTANCE_OK=0
  if (( OBSERVE_EXIT_CODE == 0 )) \
    && [[ -n "$OBSERVE_REPORT" && -f "$OBSERVE_REPORT" ]] \
    && node -e '
      const fs = require("node:fs");
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const eligible = report?.acceptance?.liveStabilityEligible === true;
      const runtime = Number(report?.metrics?.activeRuntimeMs);
      process.exit(eligible && runtime >= 86_400_000 ? 0 : 1);
    ' "$OBSERVE_REPORT"; then
    OBSERVE_ACCEPTANCE_OK=1
    OBSERVE_STATUS="COMPLETED_24H"
  else
    OBSERVE_STATUS="INCOMPLETE_OR_FAILED_$OBSERVE_EXIT_CODE"
  fi

  PAPER_REPORT_OK=0
  if operator_process_running "$PAPER_PID"; then
    if kill -TERM "$PAPER_PID" 2>/dev/null; then
      operator_wait_child "$PAPER_PID" stopping || PAPER_EXIT_CODE=$?
      if (( PAPER_EXIT_CODE == 0 )); then
        PAPER_STATUS="STOPPED_AFTER_OBSERVE"
      else
        PAPER_STATUS="ERROR_AFTER_OBSERVE_$PAPER_EXIT_CODE"
      fi
    else
      operator_wait_child "$PAPER_PID" || PAPER_EXIT_CODE=$?
      PAPER_STATUS="UNEXPECTED_EXIT_$PAPER_EXIT_CODE"
    fi
  else
    operator_wait_child "$PAPER_PID" || PAPER_EXIT_CODE=$?
    PAPER_STATUS="UNEXPECTED_EXIT_$PAPER_EXIT_CODE"
  fi

  if (( PAPER_EXIT_CODE == 0 )) && [[ "$PAPER_STATUS" == "STOPPED_AFTER_OBSERVE" ]]; then
    PAPER_REPORT="$(operator_latest_result_since "$PROJECT_ROOT/data/paper" 'paper-*.json' "$RESULT_MARKER" || true)"
    if [[ -n "$PAPER_REPORT" && -f "$PAPER_REPORT" ]] \
      && node -e '
        const fs = require("node:fs");
        const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const safety = report?.safety ?? {};
        process.exit(
          report?.mode === "PAPER"
          && report?.status === "COMPLETED"
          && safety.privateKeyLoaded === false
          && safety.authenticatedTradingClientPresent === false
          && Number(safety.realOrdersCreated) === 0
          && Number(safety.chainWrites) === 0
          && safety.liveExecutorPresent === false
            ? 0
            : 1,
        );
      ' "$PAPER_REPORT"; then
      PAPER_REPORT_OK=1
    else
      PAPER_STATUS="INVALID_OR_MISSING_REPORT"
    fi
  fi

  if (( OBSERVE_ACCEPTANCE_OK != 1 || PAPER_EXIT_CODE != 0 || PAPER_REPORT_OK != 1 )) \
    || [[ "$PAPER_STATUS" == UNEXPECTED_EXIT_* ]]; then
    print "联合验证异常或未达到 24 小时门槛（Paper=$PAPER_STATUS, Observe=$OBSERVE_STATUS）。"
    print "系统正在整理结果；随后请把 Finder 中选中的 ZIP 发给 Codex。"
    exit 1
  fi
else
  operator_wait_child "$PAPER_PID" || PAPER_EXIT_CODE=$?
  PAPER_STATUS="UNEXPECTED_EXIT_$PAPER_EXIT_CODE"
  if operator_process_running "$OBSERVE_PID"; then
    kill -TERM "$OBSERVE_PID" 2>/dev/null || true
    operator_wait_child "$OBSERVE_PID" stopping || true
    OBSERVE_STATUS="STOPPED_AFTER_PAPER"
  else
    operator_wait_child "$OBSERVE_PID" || OBSERVE_EXIT_CODE=$?
    OBSERVE_STATUS="EXIT_$OBSERVE_EXIT_CODE"
  fi
  print "Paper 验证异常结束（Paper=$PAPER_STATUS, Observe=$OBSERVE_STATUS）。"
  print "系统正在整理结果；随后请把 Finder 中选中的 ZIP 发给 Codex。"
  exit 1
fi

title "Paper + Observe 运行已结束"
print "24 小时任务已自动停止。"
print "系统正在整理结果；随后请把 Finder 中选中的 ZIP 发给 Codex。"
