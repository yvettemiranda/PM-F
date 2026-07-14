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
OPERATOR_RESULT_ZIP=""
OPERATOR_MANAGED_LOG_ACTIVE=0
OPERATOR_MANAGED_LOG_FIFO=""
OPERATOR_MANAGED_LOG_TEE_PID=""

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

operator_managed_log_to() {
  local log_file="$1"
  mkdir -p "${log_file:h}" "$RUN_DIR"
  OPERATOR_MANAGED_LOG_FIFO="$RUN_DIR/operator-log-$$.fifo"
  rm -f "$OPERATOR_MANAGED_LOG_FIFO"
  mkfifo "$OPERATOR_MANAGED_LOG_FIFO"
  exec 3>&1 4>&2
  /usr/bin/tee -a "$log_file" < "$OPERATOR_MANAGED_LOG_FIFO" >&3 &
  OPERATOR_MANAGED_LOG_TEE_PID=$!
  exec > "$OPERATOR_MANAGED_LOG_FIFO" 2>&1
  OPERATOR_MANAGED_LOG_ACTIVE=1
}

operator_finish_managed_log() {
  local attempt=0
  if (( OPERATOR_MANAGED_LOG_ACTIVE == 0 )); then
    return 0
  fi
  exec 1>&3 2>&4
  exec 3>&- 4>&-
  while operator_process_running "$OPERATOR_MANAGED_LOG_TEE_PID" && (( attempt < 100 )); do
    sleep 0.1
    (( attempt += 1 ))
  done
  if operator_process_running "$OPERATOR_MANAGED_LOG_TEE_PID"; then
    print "警告：日志写入器未能在 10 秒内结束，日志尾部可能不完整。"
    kill -TERM "$OPERATOR_MANAGED_LOG_TEE_PID" 2>/dev/null || true
    attempt=0
    while operator_process_running "$OPERATOR_MANAGED_LOG_TEE_PID" && (( attempt < 20 )); do
      sleep 0.1
      (( attempt += 1 ))
    done
  fi
  if operator_process_running "$OPERATOR_MANAGED_LOG_TEE_PID"; then
    kill -KILL "$OPERATOR_MANAGED_LOG_TEE_PID" 2>/dev/null || true
    attempt=0
    while operator_process_running "$OPERATOR_MANAGED_LOG_TEE_PID" && (( attempt < 20 )); do
      sleep 0.1
      (( attempt += 1 ))
    done
  fi
  if operator_process_running "$OPERATOR_MANAGED_LOG_TEE_PID"; then
    print "警告：日志写入器仍未退出，继续整理已有结果。"
  else
    wait "$OPERATOR_MANAGED_LOG_TEE_PID" 2>/dev/null || true
  fi
  rm -f "$OPERATOR_MANAGED_LOG_FIFO"
  OPERATOR_MANAGED_LOG_ACTIVE=0
  OPERATOR_MANAGED_LOG_FIFO=""
  OPERATOR_MANAGED_LOG_TEE_PID=""
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
      print "请先双击停止按钮，再启动新的任务。"
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
    print "请先双击停止按钮清理，再启动新的任务。"
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
    print "已启用 macOS 防睡眠保护（可以锁屏或自动黑屏，但不要合上 MacBook 盖子）。"
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
  local wait_mode="${2:-normal}"
  local child_exit_code=0 attempt=0 forced_kill=0

  if [[ "$wait_mode" != "stopping" ]]; then
    if wait "$pid"; then
      child_exit_code=0
    else
      child_exit_code=$?
    fi
    if ! operator_process_running "$pid"; then
      operator_untrack_child "$pid"
      return "$child_exit_code"
    fi
    kill -TERM "$pid" 2>/dev/null || true
  fi

  while operator_process_running "$pid" && (( attempt < 450 )); do
    sleep 0.1
    (( attempt += 1 ))
  done
  if operator_process_running "$pid"; then
    print "进程 $pid 未能在 45 秒内安全停止，执行强制清理。"
    kill -KILL "$pid" 2>/dev/null || true
    forced_kill=1
    attempt=0
    while operator_process_running "$pid" && (( attempt < 50 )); do
      sleep 0.1
      (( attempt += 1 ))
    done
  fi
  if operator_process_running "$pid"; then
    print "进程 $pid 仍未退出，不再阻塞结果整理。"
    operator_untrack_child "$pid"
    return 1
  fi

  if wait "$pid"; then
    child_exit_code=0
  else
    child_exit_code=$?
  fi
  operator_untrack_child "$pid"
  if (( forced_kill == 1 )); then
    return 1
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
      attempt=0
      while operator_process_running "$pid" && (( attempt < 50 )); do
        sleep 0.1
        (( attempt += 1 ))
      done
    fi
    if operator_process_running "$pid"; then
      print "进程 $pid 仍未退出，不再阻塞清理。"
      continue
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

operator_latest_result_since() {
  local directory="$1"
  local pattern="$2"
  local marker="$3"
  local candidate
  local -a candidates
  candidates=("$directory"/${~pattern}(N.om))
  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" -nt "$marker" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}

operator_copy_sanitized_observe_report() {
  local source_file="$1"
  local destination_file="$2"
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const fs = require("node:fs");
    const [source, destination, projectRoot, homeDirectory] = process.argv.slice(1);
    const visit = (value) => {
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, childValue]) => [key, visit(childValue)]));
      }
      if (typeof value !== "string") return value;
      return value
        .split(projectRoot).join("[PROJECT_ROOT]")
        .split(homeDirectory).join("[HOME]");
    };
    const report = JSON.parse(fs.readFileSync(source, "utf8"));
    fs.writeFileSync(destination, `${JSON.stringify(visit(report), null, 2)}\n`, { mode: 0o600 });
  ' "$source_file" "$destination_file" "$PROJECT_ROOT" "$HOME"
}

operator_copy_sanitized_paper_report() {
  local source_file="$1"
  local destination_file="$2"
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const fs = require("node:fs");
    const [source, destination, projectRoot, homeDirectory] = process.argv.slice(1);
    const redactedKeys = new Set(["accountId", "paperAccountId", "accountIdFile", "databasePath"]);
    const report = JSON.parse(fs.readFileSync(source, "utf8"));
    const accountIds = new Set();
    const collectAccountIds = (value, key = "") => {
      if (redactedKeys.has(key) && typeof value === "string" && value) accountIds.add(value);
      if (Array.isArray(value)) value.forEach((item) => collectAccountIds(item));
      else if (value && typeof value === "object") {
        Object.entries(value).forEach(([childKey, childValue]) => collectAccountIds(childValue, childKey));
      }
    };
    collectAccountIds(report);
    const visit = (value, key = "") => {
      if (redactedKeys.has(key)) return "[REDACTED]";
      if (Array.isArray(value)) return value.map((item) => visit(item));
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          visit(childValue, childKey),
        ]));
      }
      if (typeof value !== "string") return value;
      let result = value
        .split(projectRoot).join("[PROJECT_ROOT]")
        .split(homeDirectory).join("[HOME]");
      for (const accountId of accountIds) {
        result = result.split(accountId).join("[REDACTED_PAPER_ACCOUNT_ID]");
      }
      return result;
    };
    fs.writeFileSync(destination, `${JSON.stringify(visit(report), null, 2)}\n`, { mode: 0o600 });
  ' "$source_file" "$destination_file" "$PROJECT_ROOT" "$HOME"
}

operator_copy_sanitized_log() {
  local source_file="$1"
  local destination_file="$2"
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const fs = require("node:fs");
    const [source, destination, projectRoot, homeDirectory] = process.argv.slice(1);
    let content = fs.readFileSync(source, "utf8")
      .split(projectRoot).join("[PROJECT_ROOT]")
      .split(homeDirectory).join("[HOME]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_UUID]");
    fs.writeFileSync(destination, content, { mode: 0o600 });
  ' "$source_file" "$destination_file" "$PROJECT_ROOT" "$HOME"
}

operator_create_codex_bundle() {
  local marker="$1"
  local log_file="$2"
  local run_label="${3:-24小时联合验证}"
  local paper_status="${4:-UNKNOWN}"
  local observe_status="${5:-UNKNOWN}"
  local run_started_at="${6:-UNKNOWN}"
  local stamp bundle_root bundle_dir bundle_fallback bundle_zip bundle_zip_temporary observe_report paper_report
  local -a included=()
  local -a missing=()

  stamp="$(date +%Y%m%d-%H%M%S)-$$"
  bundle_root="$PROJECT_ROOT/交给Codex"
  bundle_dir="$bundle_root/.bundle-$stamp.tmp"
  bundle_fallback="$bundle_root/发给Codex_$stamp"
  bundle_zip="$bundle_root/发给Codex_$stamp.zip"
  bundle_zip_temporary="$bundle_root/.发给Codex_$stamp.tmp.zip"
  mkdir -p "$bundle_dir"

  observe_report="$(operator_latest_result_since "$PROJECT_ROOT/data/observe" 'observe-*.json' "$marker" || true)"
  paper_report="$(operator_latest_result_since "$PROJECT_ROOT/data/paper" 'paper-*.json' "$marker" || true)"

  if [[ -n "$observe_report" && -f "$observe_report" ]]; then
    if operator_copy_sanitized_observe_report "$observe_report" "$bundle_dir/observe-report-redacted.json"; then
      included+=("observe-report-redacted.json")
    else
      rm -f "$bundle_dir/observe-report-redacted.json"
      missing+=("Observe 报告（脱敏失败）")
    fi
  else
    missing+=("Observe 报告")
  fi
  if [[ -n "$paper_report" && -f "$paper_report" ]]; then
    if operator_copy_sanitized_paper_report "$paper_report" "$bundle_dir/paper-report-redacted.json"; then
      included+=("paper-report-redacted.json")
    else
      rm -f "$bundle_dir/paper-report-redacted.json"
      missing+=("Paper 报告（脱敏失败）")
    fi
  else
    missing+=("Paper 报告")
  fi
  if [[ -f "$log_file" ]]; then
    if operator_copy_sanitized_log "$log_file" "$bundle_dir/run-log-redacted.log"; then
      included+=("run-log-redacted.log")
    else
      rm -f "$bundle_dir/run-log-redacted.log"
      missing+=("运行日志（脱敏失败）")
    fi
  else
    missing+=("运行日志")
  fi

  {
    print "Polymarket 跟单系统：$run_label"
    print "运行开始：$run_started_at"
    print "生成时间：$(date '+%Y-%m-%d %H:%M:%S %z')"
    print "Paper 进程状态：$paper_status"
    print "Observe 进程状态：$observe_status"
    print "是否收到提前停止请求：$([[ $OPERATOR_STOP_REQUESTED == 1 ]] && print 是 || print 否)"
    print "代码版本：$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || print UNKNOWN)"
    print ""
    print "已包含："
    if (( ${#included[@]} == 0 )); then
      print -- "- 无"
    else
      local item
      for item in "${included[@]}"; do
        print -- "- $item"
      done
    fi
    if (( ${#missing[@]} > 0 )); then
      print ""
      print "本次未生成："
      local missing_item
      for missing_item in "${missing[@]}"; do
        print -- "- $missing_item"
      done
      print "这通常表示任务提前失败；日志仍可用于 Codex 排查。"
    fi
    print ""
    print "操作：请直接把旁边的 ZIP 文件发给 Codex，不需要再进入 data 文件夹找文件。"
    print "脱敏：Paper 内部账户 ID 和本机项目绝对路径已从 Observe/Paper 报告与日志副本中移除。"
    print "安全状态：本次仅为 Paper + Observe，不包含 private key、真实订单或链上写操作。"
  } > "$bundle_dir/请把整个ZIP发给Codex.txt"

  local archive_created=0 archive_entry_count=0 expected_archive_entry_count=$((${#included[@]} + 1))
  if command -v zip >/dev/null 2>&1; then
    if (cd "$bundle_dir" && zip -qrX "$bundle_zip_temporary" .); then
      archive_created=1
    fi
  elif command -v ditto >/dev/null 2>&1; then
    if COPYFILE_DISABLE=1 ditto --norsrc --noextattr -c -k "$bundle_dir" "$bundle_zip_temporary"; then
      archive_created=1
    fi
  fi
  if (( archive_created == 1 )); then
    if ! command -v unzip >/dev/null 2>&1; then
      archive_created=0
    else
      archive_entry_count="$(LC_ALL=C unzip -Z1 "$bundle_zip_temporary" 2>/dev/null | wc -l | tr -d '[:space:]')"
      if ! unzip -tq "$bundle_zip_temporary" >/dev/null 2>&1 \
        || [[ "$archive_entry_count" != "$expected_archive_entry_count" ]] \
        || LC_ALL=C unzip -Z1 "$bundle_zip_temporary" 2>/dev/null | LC_ALL=C grep -Eq '(^|/)\._|^__MACOSX/|/$'; then
        archive_created=0
      fi
    fi
  fi

  if (( archive_created == 1 )); then
    mv -f "$bundle_zip_temporary" "$bundle_zip"
    if [[ "$bundle_dir" == "$bundle_root"/.bundle-*.tmp ]]; then
      rm -rf -- "$bundle_dir"
    fi
    OPERATOR_RESULT_ZIP="$bundle_zip"
  else
    rm -f "$bundle_zip_temporary"
    mv "$bundle_dir" "$bundle_fallback"
    print "警告：ZIP 压缩失败，已保留未压缩结果文件夹。"
    OPERATOR_RESULT_ZIP="$bundle_fallback"
  fi
  rm -f "$marker"

  print ""
  print "结果已经自动整理好："
  print "$OPERATOR_RESULT_ZIP"
  print "你只需要把这个 ZIP（或结果文件夹）发给 Codex。"
}

open_codex_results() {
  local results_dir="$PROJECT_ROOT/交给Codex"
  mkdir -p "$results_dir"
  open "$results_dir"
}

reveal_codex_result() {
  if [[ -n "$OPERATOR_RESULT_ZIP" && -e "$OPERATOR_RESULT_ZIP" ]]; then
    open -R "$OPERATOR_RESULT_ZIP" 2>/dev/null || open_codex_results || true
  else
    open_codex_results || true
  fi
}

latest_files_hint() {
  print ""
  print "你要发给 Codex 的文件通常在这些文件夹："
  print -- "- Observe 报告：$PROJECT_ROOT/data/observe/"
  print -- "- Paper 报告：$PROJECT_ROOT/data/paper/"
  print -- "- 诊断报告：$PROJECT_ROOT/data/validation/ 或 $PROJECT_ROOT/data/operational/"
  print -- "- 运行日志：$PROJECT_ROOT/data/operator/logs/"
}
