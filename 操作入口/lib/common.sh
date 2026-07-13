#!/bin/zsh
set -euo pipefail

TARGET_WALLET="0x0c0e270cf879583d6a0142fc817e05b768d0434e"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$HOME/Library/pnpm:$HOME/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"

DATA_DIR="$PROJECT_ROOT/data"
LOG_DIR="$DATA_DIR/operator/logs"
RUN_DIR="$DATA_DIR/operator/run"
PAPER_ACCOUNT_ID_FILE="$DATA_DIR/operator/paper-account-id.txt"
mkdir -p "$LOG_DIR" "$RUN_DIR"

typeset -ga OPERATOR_CHILD_PIDS=()
OPERATOR_SESSION_FILE=""
OPERATOR_SESSION_LOCK_DIR=""
OPERATOR_KEEP_AWAKE_PID=""
OPERATOR_STOP_REQUESTED=0
OPERATOR_SESSIONS_STOPPED=0

title() {
  print ""
  print "============================================================"
  print "$1"
  print "============================================================"
}

pause_if_double_clicked() {
  print ""
  print "如果这个窗口是双击打开的，可以看完上面的结果后关闭。"
  if [[ -t 0 ]]; then
    print "按回车键关闭窗口。"
    read -r _unused || true
  fi
}

operator_log_to() {
  local log_file="$1"
  mkdir -p "${log_file:h}"
  exec > >(tee -a "$log_file") 2>&1
}

operator_process_running() {
  local pid="$1"
  local state
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -p "$pid" -o state= 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$state" && "$state" != Z* ]]
}

operator_record_is_active() {
  local record_file="$1"
  local record pid kind launcher command
  [[ -f "$record_file" ]] || return 1
  record="$(<"$record_file")"
  IFS=$'\t' read -r pid kind launcher <<< "$record"
  [[ "$pid" == <-> ]] || return 1
  [[ "$launcher" == "$PROJECT_ROOT/操作入口/"*.command ]] || return 1
  operator_process_running "$pid" || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"${launcher:t}"* ]]
}

operator_session_begin() {
  local kind="$1"
  local launcher="${2:A}"
  local existing

  for existing in "$RUN_DIR"/*.session(N); do
    if operator_record_is_active "$existing"; then
      print "已有本项目长期任务正在运行：$(<"$existing")"
      print "请先双击 3_停止当前运行.command，再启动新的任务。"
      return 1
    fi
    rm -f "$existing"
  done

  OPERATOR_SESSION_LOCK_DIR="$RUN_DIR/active.lock"
  OPERATOR_SESSION_FILE="$OPERATOR_SESSION_LOCK_DIR/session"
  if ! mkdir "$OPERATOR_SESSION_LOCK_DIR" 2>/dev/null; then
    if operator_record_is_active "$OPERATOR_SESSION_FILE"; then
      print "已有本项目长期任务正在运行：$(<"$OPERATOR_SESSION_FILE")"
    else
      print "发现上次异常退出留下的安全锁。"
    fi
    print "请先双击 3_停止当前运行.command 清理，再启动新的任务。"
    return 1
  fi
  local temporary="$OPERATOR_SESSION_LOCK_DIR/session.$$.tmp"
  printf '%s\t%s\t%s\n' "$$" "$kind" "$launcher" > "$temporary"
  mv -f "$temporary" "$OPERATOR_SESSION_FILE"
}

operator_track_child() {
  OPERATOR_CHILD_PIDS+=("$1")
}

operator_untrack_child() {
  local target="$1"
  local -a remaining=()
  local pid
  for pid in "${OPERATOR_CHILD_PIDS[@]}"; do
    [[ "$pid" == "$target" ]] || remaining+=("$pid")
  done
  OPERATOR_CHILD_PIDS=("${remaining[@]}")
}

operator_start_keep_awake() {
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -ims -w "$$" &
    OPERATOR_KEEP_AWAKE_PID=$!
    print "已启用 macOS 防睡眠保护（允许屏幕关闭，但任务会继续运行）。"
  else
    print "警告：未找到 macOS caffeinate。电脑睡眠会中断长期验证。"
  fi
}

operator_request_stop() {
  local signal_name="${1:-TERM}"
  local pid
  if (( OPERATOR_STOP_REQUESTED == 0 )); then
    print ""
    print "收到 $signal_name，正在安全停止并等待报告写入……"
  fi
  OPERATOR_STOP_REQUESTED=1
  for pid in "${OPERATOR_CHILD_PIDS[@]}"; do
    if operator_process_running "$pid"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}

operator_wait_child() {
  local pid="$1"
  local child_exit_code attempt=0
  set +e
  wait "$pid"
  child_exit_code=$?
  set -e
  if operator_process_running "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    while operator_process_running "$pid" && (( attempt < 450 )); do
      sleep 0.1
      (( attempt += 1 ))
    done
    if operator_process_running "$pid"; then
      print "进程 $pid 未能在 45 秒内安全停止，执行强制清理。"
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      operator_untrack_child "$pid"
      return 1
    fi
    set +e
    wait "$pid"
    child_exit_code=$?
    set -e
  fi
  operator_untrack_child "$pid"
  if (( OPERATOR_STOP_REQUESTED == 1 && child_exit_code >= 128 )); then
    return 0
  fi
  return "$child_exit_code"
}

operator_cleanup() {
  local original_status=$?
  local pid attempt
  trap - EXIT INT TERM HUP
  if (( ${#OPERATOR_CHILD_PIDS[@]} > 0 )); then
    operator_request_stop EXIT
  fi
  for pid in "${OPERATOR_CHILD_PIDS[@]}"; do
    attempt=0
    while operator_process_running "$pid" && (( attempt < 450 )); do
      sleep 0.1
      (( attempt += 1 ))
    done
    if operator_process_running "$pid"; then
      print "进程 $pid 未能在 45 秒内安全停止，执行强制清理。"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  OPERATOR_CHILD_PIDS=()
  if [[ -n "$OPERATOR_KEEP_AWAKE_PID" ]]; then
    kill -TERM "$OPERATOR_KEEP_AWAKE_PID" 2>/dev/null || true
    wait "$OPERATOR_KEEP_AWAKE_PID" 2>/dev/null || true
    OPERATOR_KEEP_AWAKE_PID=""
  fi
  if [[ -n "$OPERATOR_SESSION_FILE" ]]; then
    rm -f "$OPERATOR_SESSION_FILE"
  fi
  if [[ -n "$OPERATOR_SESSION_LOCK_DIR" ]]; then
    rmdir "$OPERATOR_SESSION_LOCK_DIR" 2>/dev/null || true
  fi
  return "$original_status"
}

operator_stop_registered_sessions() {
  OPERATOR_SESSIONS_STOPPED=0
  local record_file record pid kind launcher
  for record_file in "$RUN_DIR/active.lock/session"(N) "$RUN_DIR"/*.session(N); do
    if operator_record_is_active "$record_file"; then
      record="$(<"$record_file")"
      IFS=$'\t' read -r pid kind launcher <<< "$record"
      print "安全停止 $kind 任务（进程 $pid）"
      kill -TERM "$pid"
      OPERATOR_SESSIONS_STOPPED=1
    else
      print "清理已失效的运行记录：${record_file:t}"
      rm -f "$record_file"
    fi
  done
  if [[ -d "$RUN_DIR/active.lock" && ! -f "$RUN_DIR/active.lock/session" ]]; then
    print "清理上次异常退出留下的安全锁。"
    rm -f "$RUN_DIR/active.lock"/*.tmp(N)
    rmdir "$RUN_DIR/active.lock" 2>/dev/null || true
  fi
  return 0
}

operator_tsx() {
  "$PROJECT_ROOT/node_modules/.bin/tsx" "$@"
}

ensure_ready() {
  cd "$PROJECT_ROOT"
  title "安全边界"
  print "当前入口只运行 Observe / Paper / 报告检查。"
  print "不会开启 Live，不读取 private key，不创建真实订单，不执行链上写操作。"

  title "环境检查"
  if ! command -v node >/dev/null 2>&1; then
    print "未找到 Node.js。需要先安装 Node.js 24 或以上。"
    exit 1
  fi
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 14 ? 0 : 1)' >/dev/null 2>&1; then
    print "当前 Node 版本不在已验证范围：$(node -v)"
    print "需要 Node.js 24.14.x 或更新的 Node.js 24 版本。"
    exit 1
  fi
  print "Node: $(node -v)"

  if ! command -v pnpm >/dev/null 2>&1; then
    print "未找到 pnpm。请先安装 pnpm，或在 Terminal 中运行：corepack enable"
    exit 1
  fi
  print "pnpm: $(pnpm -v)"

  title "校验锁定依赖"
  pnpm install --frozen-lockfile
}

ensure_phase0_database() {
  cd "$PROJECT_ROOT"
  if [[ ! -f "$PROJECT_ROOT/data/phase0/phase0.sqlite" ]]; then
    title "第一次运行，正在准备数据库"
    pnpm phase0:validate -- "$TARGET_WALLET"
  fi
}

open_report_folders() {
  mkdir -p "$PROJECT_ROOT/data/observe" "$PROJECT_ROOT/data/paper" "$PROJECT_ROOT/data/validation" "$PROJECT_ROOT/data/operational" "$PROJECT_ROOT/data/operator/logs"
  open "$PROJECT_ROOT/data"
}

latest_files_hint() {
  print ""
  print "你要发给 Codex 的文件通常在这些文件夹："
  print -- "- Observe 报告：$PROJECT_ROOT/data/observe/"
  print -- "- Paper 报告：$PROJECT_ROOT/data/paper/"
  print -- "- 诊断报告：$PROJECT_ROOT/data/validation/ 或 $PROJECT_ROOT/data/operational/"
  print -- "- 运行日志：$PROJECT_ROOT/data/operator/logs/"
}
