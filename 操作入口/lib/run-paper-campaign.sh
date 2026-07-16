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
PHASE0_RESULT_FILE="$EVIDENCE_DIR/paper-campaign-phase0-$STAMP.json"
TEST_RESULTS_FILE="$EVIDENCE_DIR/paper-campaign-vitest-$STAMP.json"
REPLAY_RESULT_FILE="$EVIDENCE_DIR/paper-campaign-replay-$STAMP.json"
RESULT_PACKAGED=0
mkdir -p "$EVIDENCE_DIR"

abort_if_stop_requested() {
  if (( OPERATOR_STOP_REQUESTED == 1 )); then
    print "已收到停止请求；不会启动 Paper Campaign，正在整理本次日志。"
    exit 130
  fi
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
      "$ISOLATED_EVIDENCE_FILE" || true
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

ensure_ready
abort_if_stop_requested
ensure_phase0_database
abort_if_stop_requested

if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
  print "代码目录存在未提交改动。为保证累计时间可复现，本次拒绝启动。"
  print "请把窗口内容交给 Codex，不要自行清理数据库。"
  exit 1
fi

cd "$PROJECT_ROOT"
node --import tsx src/cli/paper-campaign-preflight.ts
abort_if_stop_requested
if ! node --import tsx src/cli/paper-campaign-evidence.ts verify \
  --file="$ISOLATED_EVIDENCE_FILE" >/dev/null 2>&1; then
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

  title "刷新真实公开数据并验证 Replay 稳定性"
  pnpm phase0:validate -- "$TARGET_WALLET" | tee "$PHASE0_RESULT_FILE"
  abort_if_stop_requested
  CAPTURE_RUN_ID="$(node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const start = text.indexOf("{");
    if (start < 0) process.exit(2);
    const value = JSON.parse(text.slice(start));
    if (!/^[a-f0-9]{64}$/.test(value.captureRunId ?? "")) process.exit(3);
    process.stdout.write(value.captureRunId);
  ' "$PHASE0_RESULT_FILE")"
  pnpm phase05:replay-capture -- "$CAPTURE_RUN_ID" | tee "$REPLAY_RESULT_FILE"
  abort_if_stop_requested
  node --import tsx src/cli/paper-campaign-evidence.ts write-passed \
    --file="$ISOLATED_EVIDENCE_FILE" \
    --test-results="$TEST_RESULTS_FILE" \
    --phase0-results="$PHASE0_RESULT_FILE" \
    --replay-results="$REPLAY_RESULT_FILE"
  abort_if_stop_requested
fi

abort_if_stop_requested
operator_start_keep_awake
title "自然数据运行"
print "第一次自动运行约 2 小时；短测通过后，每次自动运行最多 12 小时。"
print "可以随时双击“2_安全暂停并生成报告”。"
print "注意：首次资格短测若提前安全暂停，已验证的健康时长仍计入 72 小时；下次仍需完成整段 2 小时资格短测。"
print "资格短测通过后，后续每段已安全收尾的有效时间也会继续累计。"
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
