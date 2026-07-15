#!/bin/zsh
set -euo pipefail

MODE="${1:-}"
DURATION_SECONDS="${2:-}"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

case "$MODE" in
  short)
    RUN_LABEL="Paper 短测 2 小时"
    SESSION_KIND="paper-short"
    ;;
  long)
    RUN_LABEL="Paper 长期验收 7 天"
    SESSION_KIND="paper-long"
    ;;
  *)
    print "内部参数错误：未知 Paper 验收模式。"
    exit 64
    ;;
esac

if [[ "$DURATION_SECONDS" != <-> ]] || (( DURATION_SECONDS <= 0 )); then
  print "内部参数错误：运行时间无效。"
  exit 64
fi

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
LOG_FILE="$LOG_DIR/${SESSION_KIND}-${STAMP}.log"
READY_FILE="$RUN_DIR/${SESSION_KIND}-ready-$$.json"
ACCOUNT_ID_FILE="$RUN_DIR/${SESSION_KIND}-account-$$.txt"
RESULT_MARKER="$RUN_DIR/${SESSION_KIND}-results-$$.marker"
VERIFICATION_FILE="$RUN_DIR/${SESSION_KIND}-isolated-verification-$$.json"
SHORT_GATE_FILE="$DATA_DIR/operator/paper-short-gate.json"
RESULT_PACKAGED=0
RUN_STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S %z')"
PAPER_STATUS="NOT_STARTED"
OBSERVE_STATUS="NOT_STARTED"

title "启动 $RUN_LABEL"
if ! operator_session_begin "$SESSION_KIND" "$0"; then
  print "本次没有启动新任务，也不会生成新结果包。"
  pause_if_double_clicked
  exit 1
fi
trap 'operator_cleanup' EXIT

operator_managed_log_to "$LOG_FILE"
: > "$RESULT_MARKER"

finalize_paper_validation() {
  local original_status="${1:-0}"
  trap - EXIT INT TERM HUP
  operator_cleanup || true
  operator_finish_managed_log || true
  if (( RESULT_PACKAGED == 0 )); then
    operator_create_codex_bundle \
      "$RESULT_MARKER" \
      "$LOG_FILE" \
      "$RUN_LABEL" \
      "$PAPER_STATUS" \
      "$OBSERVE_STATUS" \
      "$RUN_STARTED_AT" \
      "$VERIFICATION_FILE" || true
    RESULT_PACKAGED=1
  fi
  rm -f "$RESULT_MARKER" "$READY_FILE" "$ACCOUNT_ID_FILE" "$VERIFICATION_FILE"
  reveal_codex_result
  return "$original_status"
}
trap 'finalize_paper_validation $?' EXIT
trap 'operator_request_stop INT' INT
trap 'operator_request_stop TERM' TERM
trap 'operator_request_stop HUP' HUP

ensure_ready
ensure_phase0_database

if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
  print "代码目录存在未提交改动。为保证报告可以复现，本次拒绝启动。"
  print "请把这个窗口内容交给 Codex 处理。"
  exit 1
fi

SOURCE_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"

if [[ "$MODE" == "short" ]]; then
  rm -f "$SHORT_GATE_FILE"
else
  if [[ ! -f "$SHORT_GATE_FILE" ]] || ! node -e '
    const fs = require("node:fs");
    const [path, commit] = process.argv.slice(1);
    const gate = JSON.parse(fs.readFileSync(path, "utf8"));
    process.exit(gate.status === "SHORT_PAPER_GATE_PASSED" && gate.sourceCommit === commit ? 0 : 1);
  ' "$SHORT_GATE_FILE" "$SOURCE_COMMIT"; then
    print "还没有同一代码版本的 Paper 短测通过记录。"
    print "请先双击“1_开始Paper短测_2小时.command”。"
    exit 1
  fi
fi

title "运行隔离验证"
print "先验证买入、卖出、止损、结算、账本、无盘口保护和崩溃恢复。"
cd "$PROJECT_ROOT"
pnpm typecheck
pnpm exec vitest run \
  tests/execution-market-data.test.ts \
  tests/paper-executor.test.ts \
  tests/paper-runner-options.test.ts \
  tests/paper-acceptance-summary.test.ts \
  tests/settlement-service.test.ts \
  tests/validation-framework.test.ts

node -e '
  const fs = require("node:fs");
  const [output, commit] = process.argv.slice(1);
  const report = {
    status: "PASSED",
    sourceCommit: commit,
    sourceDirty: false,
    generatedAt: new Date().toISOString(),
    safety: {
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      realOrdersCreated: 0,
      privateKeyLoaded: false,
      chainWrites: 0,
    },
    coverage: {
      BUY: "VERIFIED_ISOLATED",
      SELL: "VERIFIED_ISOLATED",
      POSITION: "VERIFIED_ISOLATED",
      CASH_LEDGER: "VERIFIED_ISOLATED",
      PNL: "VERIFIED_ISOLATED",
      FEE: "VERIFIED_ISOLATED",
      RESERVATION: "VERIFIED_ISOLATED",
      STOP_LOSS: "VERIFIED_ISOLATED",
      SETTLEMENT: "VERIFIED_ISOLATED",
      CRASH_RECOVERY: "VERIFIED_ISOLATED",
      NO_ORDERBOOK_SAFETY: "VERIFIED_ISOLATED",
    },
    note: "隔离测试通过不代表自然数据长跑通过；自然运行证据仍以 Observe/Paper 报告为准。",
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
' "$VERIFICATION_FILE" "$SOURCE_COMMIT"

if (( OPERATOR_STOP_REQUESTED == 1 )); then
  PAPER_STATUS="STOPPED_BEFORE_START"
  OBSERVE_STATUS="STOPPED_BEFORE_START"
  exit 130
fi

operator_start_keep_awake
rm -f "$READY_FILE" "$ACCOUNT_ID_FILE"

title "开始自然数据运行"
print "运行时间：$([[ "$MODE" == "short" ]] && print '2 小时' || print '7 天')"
print "使用全新 1000 pUSD Paper 账户，只消费启动后的当前目标钱包 Signal。"
print "到时会自动停止、生成报告、打包 ZIP 并打开 Finder。"
print "本入口固定 PAPER + LIVE_DISABLED，不读取私钥，不创建真实订单。"
print "运行期间请接通电源、保持网络，不要合上 MacBook 盖子。"

operator_tsx "$PROJECT_ROOT/src/cli/paper-run.ts" \
  --duration-seconds=0 \
  --interval-seconds=1 \
  --new-account \
  --target-wallet="$TARGET_WALLET" \
  --account-name="$RUN_LABEL" \
  --account-id-file="$ACCOUNT_ID_FILE" \
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
  exit 130
fi

if [[ ! -s "$READY_FILE" ]] || ! node -e '
  const fs = require("node:fs");
  const [path, wallet] = process.argv.slice(1);
  const ready = JSON.parse(fs.readFileSync(path, "utf8"));
  process.exit(
    ready.status === "READY"
      && ready.mode === "PAPER"
      && ready.accountSource === "CREATED"
      && ready.targetId
      && ready.targetWallet === wallet
      ? 0 : 1,
  );
' "$READY_FILE" "$TARGET_WALLET"; then
  print "Paper 未能以全新、绑定目标钱包的账户启动。Observe 不会启动。"
  operator_request_stop READY_INVALID
  operator_wait_child "$PAPER_PID" stopping || true
  PAPER_STATUS="READY_INVALID"
  exit 1
fi

operator_tsx "$PROJECT_ROOT/src/cli/observe-only.ts" "$TARGET_WALLET" \
  --duration-seconds="$DURATION_SECONDS" \
  --poll-seconds=15 \
  --minimum-soak-seconds="$DURATION_SECONDS" &
OBSERVE_PID=$!
OBSERVE_STATUS="RUNNING"
operator_track_child "$OBSERVE_PID"

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
  print "任务已提前停止；系统会整理已有报告，但不会标记通过。"
  exit 130
fi

if operator_process_running "$OBSERVE_PID"; then
  print "Paper 意外提前结束，正在停止 Observe。"
  operator_wait_child "$PAPER_PID" || PAPER_EXIT_CODE=$?
  PAPER_STATUS="UNEXPECTED_EXIT_$PAPER_EXIT_CODE"
  kill -TERM "$OBSERVE_PID" 2>/dev/null || true
  operator_wait_child "$OBSERVE_PID" stopping || true
  OBSERVE_STATUS="STOPPED_AFTER_PAPER"
  exit 1
fi

operator_wait_child "$OBSERVE_PID" || OBSERVE_EXIT_CODE=$?
OBSERVE_REPORT="$(operator_latest_result_since "$PROJECT_ROOT/data/observe" 'observe-*.json' "$RESULT_MARKER" || true)"
MINIMUM_RUNTIME_MS=$(( (DURATION_SECONDS - 30) * 1000 ))
if (( OBSERVE_EXIT_CODE == 0 )) \
  && [[ -n "$OBSERVE_REPORT" && -f "$OBSERVE_REPORT" ]] \
  && node -e '
    const fs = require("node:fs");
    const [path, wallet, commit, minimumRuntime] = process.argv.slice(1);
    const report = JSON.parse(fs.readFileSync(path, "utf8"));
    process.exit(
      report.mode === "OBSERVE_ONLY"
        && report.target === wallet
        && report.sourceCodeCommit === commit
        && report.sourceCodeDirty === false
        && report.acceptance?.observeStatus === "SHORT_SOAK_PASSED"
        && Number(report.metrics?.activeRuntimeMs) >= Number(minimumRuntime)
        ? 0 : 1,
    );
  ' "$OBSERVE_REPORT" "$TARGET_WALLET" "$SOURCE_COMMIT" "$MINIMUM_RUNTIME_MS"; then
  OBSERVE_STATUS="COMPLETED"
else
  OBSERVE_STATUS="INCOMPLETE_OR_FAILED_$OBSERVE_EXIT_CODE"
fi

if operator_process_running "$PAPER_PID"; then
  if kill -USR1 "$PAPER_PID" 2>/dev/null; then
    operator_wait_child "$PAPER_PID" stopping || PAPER_EXIT_CODE=$?
  else
    operator_wait_child "$PAPER_PID" || PAPER_EXIT_CODE=$?
  fi
else
  operator_wait_child "$PAPER_PID" || PAPER_EXIT_CODE=$?
fi

PAPER_REPORT="$(operator_latest_result_since "$PROJECT_ROOT/data/paper" 'paper-*.json' "$RESULT_MARKER" || true)"
if (( PAPER_EXIT_CODE == 0 )) \
  && [[ -n "$PAPER_REPORT" && -f "$PAPER_REPORT" ]] \
  && node -e '
    const fs = require("node:fs");
    const [paperPath, readyPath, commit] = process.argv.slice(1);
    const paper = JSON.parse(fs.readFileSync(paperPath, "utf8"));
    const ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    const safety = paper.safety ?? {};
    const acceptance = paper.report?.acceptance ?? {};
    process.exit(
      paper.mode === "PAPER"
        && paper.status === "COMPLETED"
        && paper.shutdownMode === "FINAL_VALUATION"
        && paper.sourceCodeCommit === commit
        && paper.sourceCodeDirty === false
        && paper.accountSelection?.source === "CREATED"
        && acceptance.targetId === ready.targetId
        && acceptance.consistency?.passed === true
        && Number(acceptance.marketData?.blockerCount) === 0
        && acceptance.coverage?.BUY === "OBSERVED_REAL"
        && Number(paper.report?.errorCount) === 0
        && paper.report?.account?.valuationStatus === "COMPLETE"
        && Number(paper.report?.account?.unpricedPositionCount) === 0
        && safety.privateKeyLoaded === false
        && safety.authenticatedTradingClientPresent === false
        && Number(safety.realOrdersCreated) === 0
        && Number(safety.chainWrites) === 0
        && safety.liveExecutorPresent === false
        ? 0 : 1,
    );
  ' "$PAPER_REPORT" "$READY_FILE" "$SOURCE_COMMIT"; then
  PAPER_STATUS="COMPLETED"
else
  PAPER_STATUS="INCOMPLETE_OR_FAILED_$PAPER_EXIT_CODE"
fi

if [[ "$OBSERVE_STATUS" != "COMPLETED" || "$PAPER_STATUS" != "COMPLETED" ]]; then
  print "$RUN_LABEL 没有达到通过标准（Paper=$PAPER_STATUS, Observe=$OBSERVE_STATUS）。"
  print "这不是实盘失败，也不会产生真实订单；请把自动生成的 ZIP 发给 Codex。"
  exit 1
fi

if [[ "$MODE" == "short" ]]; then
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const [output, commit, paperPath, observePath] = process.argv.slice(1);
    const digest = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
    const gate = {
      status: "SHORT_PAPER_GATE_PASSED",
      sourceCommit: commit,
      createdAt: new Date().toISOString(),
      paperReportSha256: digest(paperPath),
      observeReportSha256: digest(observePath),
      note: "仅允许进入 7 天 Paper 长期验收，不代表 Live Gate 通过。",
    };
    fs.writeFileSync(output, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600 });
  ' "$SHORT_GATE_FILE" "$SOURCE_COMMIT" "$PAPER_REPORT" "$OBSERVE_REPORT"
fi

title "$RUN_LABEL 已完成"
print "系统已自动停止并验证报告。"
print "这只表示本阶段 Paper 验收达标，不表示 Live 已获授权。"
print "系统正在打包结果；Finder 会自动选中要发给 Codex 的 ZIP。"
