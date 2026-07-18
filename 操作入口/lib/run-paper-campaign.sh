#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
LOG_FILE="$LOG_DIR/paper-campaign-$STAMP.log"
POINTER_FILE="$DATA_DIR/operator/paper-campaign-latest.json"
POINTER_MARKER="$RUN_DIR/paper-campaign-pointer-$STAMP.marker"
ISOLATED_EVIDENCE_FILE="$DATA_DIR/operator/paper-campaign-isolated-verification.json"
EVIDENCE_DIR="$DATA_DIR/operator/evidence"
PHASE0_RESULT_FILE=""
TEST_RESULTS_FILE="$EVIDENCE_DIR/paper-campaign-vitest-$STAMP.json"
REPLAY_RESULT_FILE=""
PHASE0_MAX_ATTEMPTS=3
RESULT_PACKAGED=0
mkdir -p "$EVIDENCE_DIR"

abort_if_stop_requested() {
  if (( OPERATOR_STOP_REQUESTED == 1 )); then
    print "已收到停止请求；不会启动 Paper Campaign，正在整理本次日志。"
    exit 130
  fi
}

run_fresh_phase0_attempt() {
  local attempt="$1"
  local phase0_metadata capture_run_id ambiguous_events replay_stable
  PHASE0_RESULT_FILE="$EVIDENCE_DIR/paper-campaign-phase0-$STAMP-attempt-$attempt.json"
  REPLAY_RESULT_FILE="$EVIDENCE_DIR/paper-campaign-replay-$STAMP-attempt-$attempt.json"

  title "刷新真实公开数据并验证 Replay（第 $attempt/$PHASE0_MAX_ATTEMPTS 次）"
  if ! pnpm phase0:validate -- "$TARGET_WALLET" | tee "$PHASE0_RESULT_FILE"; then
    print "第 $attempt 次公开数据采集失败；本次证据已保留。"
    return 1
  fi
  abort_if_stop_requested
  phase0_metadata="$(node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const start = text.indexOf("{");
    if (start < 0) process.exit(2);
    const value = JSON.parse(text.slice(start));
    if (!/^[a-f0-9]{64}$/.test(value.captureRunId ?? "")) process.exit(3);
    if (!Number.isSafeInteger(value.ambiguousEvents) || value.ambiguousEvents < 0) process.exit(4);
    process.stdout.write(`${value.captureRunId}\t${value.ambiguousEvents}`);
  ' "$PHASE0_RESULT_FILE" 2>/dev/null || true)"
  IFS=$'\t' read -r capture_run_id ambiguous_events <<< "$phase0_metadata"
  if [[ -z "$capture_run_id" || -z "$ambiguous_events" ]]; then
    print "第 $attempt 次 Phase 0 输出无法验证；不会生成通过证明。"
    return 2
  fi

  if ! pnpm phase05:replay-capture -- "$capture_run_id" | tee "$REPLAY_RESULT_FILE"; then
    print "第 $attempt 次 Capture Replay 失败；不会生成通过证明。"
    return 3
  fi
  abort_if_stop_requested
  replay_stable="$(node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const start = text.indexOf("{");
    if (start < 0) process.exit(2);
    const value = JSON.parse(text.slice(start));
    if (value.captureRunId !== process.argv[2] || value.stable !== true) process.exit(3);
    process.stdout.write("yes");
  ' "$REPLAY_RESULT_FILE" "$capture_run_id" 2>/dev/null || true)"
  if [[ "$replay_stable" != "yes" ]]; then
    print "第 $attempt 次 Replay 不稳定；不会生成通过证明。"
    return 4
  fi
  if (( ambiguous_events != 0 )); then
    print "第 $attempt 次原始 Replay 发现 $ambiguous_events 个 ambiguous event。"
    print "系统不会合并、接受或放宽该结果，将重新抓取一份全新公开数据。"
    return 5
  fi

  if ! node --import tsx src/cli/paper-campaign-evidence.ts write-passed \
    --file="$ISOLATED_EVIDENCE_FILE" \
    --test-results="$TEST_RESULTS_FILE" \
    --phase0-results="$PHASE0_RESULT_FILE" \
    --replay-results="$REPLAY_RESULT_FILE"; then
    print "第 $attempt 次后续 proof 校验未通过；不会接受本次结果。"
    return 6
  fi
  print "第 $attempt 次 Phase 0 与 Replay proof 已通过。"
  return 0
}

title "开始或继续 Paper 累计验证"
if ! operator_session_begin "paper-campaign" "$0"; then
  print "本次没有启动新任务。"
  pause_if_double_clicked
  exit 1
fi
trap 'operator_cleanup' EXIT
operator_managed_log_to "$LOG_FILE"
touch "$POINTER_MARKER"

finish_campaign_launcher() {
  local original_status="${1:-0}"
  local saved_session_file="$OPERATOR_SESSION_FILE"
  local saved_lock_dir="$OPERATOR_SESSION_LOCK_DIR"
  local pointer_snapshot="$RUN_DIR/paper-campaign-pointer-$STAMP.json"
  trap - EXIT INT TERM HUP
  # 报告与 ZIP 完成前保留 active.lock，让停止按钮不会误报“已经整理好”。
  OPERATOR_SESSION_FILE=""
  OPERATOR_SESSION_LOCK_DIR=""
  operator_cleanup || true
  operator_finish_managed_log || true
  if (( RESULT_PACKAGED == 0 )); then
    local pointer_for_bundle="$pointer_snapshot"
    if [[ -f "$POINTER_FILE" && "$POINTER_FILE" -nt "$POINTER_MARKER" ]]; then
      cp -p "$POINTER_FILE" "$pointer_snapshot"
    else
      pointer_for_bundle="$RUN_DIR/no-new-paper-campaign-result-$STAMP.json"
    fi
    operator_create_campaign_bundle \
      "$pointer_for_bundle" \
      "$LOG_FILE" \
      "$ISOLATED_EVIDENCE_FILE" \
      "$TEST_RESULTS_FILE" \
      "$PHASE0_RESULT_FILE" \
      "$REPLAY_RESULT_FILE" \
      "$STAMP" || true
    RESULT_PACKAGED=1
  fi
  rm -f "$POINTER_MARKER" "$pointer_snapshot"
  if [[ -n "$saved_session_file" ]]; then
    rm -f "$saved_session_file"
  fi
  if [[ -n "$saved_lock_dir" ]]; then
    rmdir "$saved_lock_dir" 2>/dev/null || true
  fi
  reveal_codex_result
  pause_if_double_clicked
  return "$original_status"
}
trap 'finish_campaign_launcher $?' EXIT
trap 'operator_request_stop INT' INT
trap 'operator_request_stop TERM' TERM
trap 'operator_request_stop HUP' HUP

if ! operator_stop_campaign_processes_from_pointer "$POINTER_FILE"; then
  print "无法确认或停止上次异常运行的进程；为避免旧进程继续写库，本次拒绝继续。"
  print "请双击“2_安全暂停并生成报告”，再把窗口结果交给 Codex。"
  exit 1
fi
abort_if_stop_requested

ensure_ready
abort_if_stop_requested

if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
  print "代码目录存在未提交改动。为保证累计时间可复现，本次拒绝启动。"
  print "请把窗口内容交给 Codex，不要自行清理数据库。"
  exit 1
fi
operator_start_keep_awake
ensure_phase0_database
abort_if_stop_requested

cd "$PROJECT_ROOT"
PREFLIGHT_OUTPUT="$(node --import tsx src/cli/paper-campaign-preflight.ts)"
print -r -- "$PREFLIGHT_OUTPUT"
PREFLIGHT_CAMPAIGN_ID="$(PREFLIGHT_OUTPUT="$PREFLIGHT_OUTPUT" node -e '
  const value = JSON.parse(process.env.PREFLIGHT_OUTPUT ?? "{}");
  if (value.campaignId === null) process.stdout.write("__NONE__");
  else if (typeof value.campaignId === "string" && /^PC-/.test(value.campaignId)) process.stdout.write(value.campaignId);
  else process.exit(2);
')"
PREFLIGHT_REPLACEMENT_REQUIRED="$(PREFLIGHT_OUTPUT="$PREFLIGHT_OUTPUT" node -e '
  const value = JSON.parse(process.env.PREFLIGHT_OUTPUT ?? "{}");
  if (value.replacementRequired === true) process.stdout.write("yes");
  else if (value.replacementRequired === false) process.stdout.write("no");
  else process.exit(2);
')"
PREFLIGHT_REVALIDATION_REQUIRED="$(PREFLIGHT_OUTPUT="$PREFLIGHT_OUTPUT" node -e '
  const value = JSON.parse(process.env.PREFLIGHT_OUTPUT ?? "{}");
  if (value.terminalRevalidationRequired === true) process.stdout.write("yes");
  else if (value.terminalRevalidationRequired === false) process.stdout.write("no");
  else process.exit(2);
')"
abort_if_stop_requested
if ! node --import tsx src/cli/paper-campaign-evidence.ts verify \
  --file="$ISOLATED_EVIDENCE_FILE" >/dev/null 2>&1; then
  if [[ "$PREFLIGHT_CAMPAIGN_ID" != "__NONE__"
    && "$PREFLIGHT_REPLACEMENT_REQUIRED" != "yes"
    && "$PREFLIGHT_REVALIDATION_REQUIRED" != "yes" ]]; then
    print "已有 Campaign $PREFLIGHT_CAMPAIGN_ID，但隔离证据缺失、损坏或版本不匹配。"
    print "为保护崩溃恢复游标，本次不会先刷新 Phase 0 数据，也不会改写数据库。"
    print "请把本次诊断包交给 Codex 处理。"
    exit 1
  fi
  if [[ "$PREFLIGHT_REPLACEMENT_REQUIRED" == "yes" ]]; then
    print "旧 Campaign 属于已结束的旧核心版本；将只读保留，并为修复后的核心重建隔离证据。"
  elif [[ "$PREFLIGHT_REVALIDATION_REQUIRED" == "yes" ]]; then
    print "已通过 Campaign 的验收策略或测试套件发生变化；将保留原始运行时长并重建隔离证据。"
  fi
  title "首次运行：自动完成隔离验证"
  print "只使用 Paper、Replay、Fake/Disabled Adapter；不会连接真实资金。"
  pnpm typecheck
  abort_if_stop_requested
  typeset -a ISOLATED_TEST_FILES
  ISOLATED_TEST_FILES=("${(@f)$(node --import tsx src/cli/paper-campaign-evidence.ts list-tests)}")
  if (( ${#ISOLATED_TEST_FILES[@]} == 0 )); then
    print "隔离测试列表为空，拒绝生成通过证据。"
    exit 1
  fi
  pnpm exec vitest run "${ISOLATED_TEST_FILES[@]}" \
    --reporter=default --reporter=json --outputFile.json="$TEST_RESULTS_FILE"
  abort_if_stop_requested

  integer phase0_attempt=1
  integer phase0_attempt_exit=0
  integer phase0_verified=0
  while (( phase0_attempt <= PHASE0_MAX_ATTEMPTS )); do
    phase0_attempt_exit=0
    run_fresh_phase0_attempt "$phase0_attempt" || phase0_attempt_exit=$?
    abort_if_stop_requested
    if (( phase0_attempt_exit == 0 )); then
      phase0_verified=1
      break
    fi
    if (( phase0_attempt < PHASE0_MAX_ATTEMPTS )); then
      print "将在短暂退避后进行下一次独立抓取。"
      sleep "$(( phase0_attempt * 2 ))"
    fi
    (( phase0_attempt += 1 ))
  done
  if (( phase0_verified != 1 )); then
    print "连续 $PHASE0_MAX_ATTEMPTS 次 Phase 0 均未形成可接受证明。"
    print "系统保持 PAPER + LIVE_DISABLED；不会创建 Campaign 或启动 Paper。"
    exit 1
  fi
fi

abort_if_stop_requested
title "自然数据运行"
print "第一次默认连续运行最多 12 小时；满 2 小时会留下资格里程碑，不会为了出报告而强制重启。"
print "可以随时双击“2_安全暂停并生成报告”。"
print "满 2 小时后如需暂停，安全收尾可完成资格判断；直接运行到 12 小时还能同时满足连续运行门槛。"
print "不足 2 小时提前暂停时，已验证的健康时长仍计入 72 小时，但资格门槛尚未完成。"
print "全程固定 PAPER + LIVE_DISABLED，不读取私钥，不创建真实订单。"

if ! operator_stop_campaign_processes_from_pointer "$POINTER_FILE"; then
  print "上次异常运行仍有进程未停止，本次不会进入数据库恢复。"
  exit 1
fi

operator_tsx "$PROJECT_ROOT/src/cli/paper-campaign-run.ts" \
  "--operator-owner-token=$STAMP" &
CAMPAIGN_PID=$!
operator_track_child "$CAMPAIGN_PID"

CAMPAIGN_EXIT=0
operator_wait_child "$CAMPAIGN_PID" || CAMPAIGN_EXIT=$?
operator_stop_campaign_processes_from_pointer "$POINTER_FILE" || true
if (( CAMPAIGN_EXIT != 0 )); then
  print "Paper 累计验证本次未通过或被保守阻断（退出码 $CAMPAIGN_EXIT）。"
  print "系统仍是 PAPER + LIVE_DISABLED；请把自动生成的 ZIP 发给 Codex。"
  exit "$CAMPAIGN_EXIT"
fi

title "本次已安全结束"
node --import tsx "$PROJECT_ROOT/src/cli/paper-campaign-status.ts" || true
