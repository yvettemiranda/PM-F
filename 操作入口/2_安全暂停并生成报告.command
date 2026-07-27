#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"
cd "$PROJECT_ROOT"

title "安全暂停 Paper 累计验证"
print "会先停止 Observe，再让 Paper 完成最后消费、释放等待买入资金并做最终估值。"
print "不会开启 Live，不会产生真实订单。"

operator_stop_registered_sessions
if (( OPERATOR_SESSIONS_STOPPED == 0 )); then
  print "当前没有正在运行的累计验证。"
else
  print "已发送安全暂停请求，正在等待报告和 ZIP 自动生成……"
  integer lock_wait_ticks="${OPERATOR_STOP_LOCK_WAIT_TICKS:-2400}"
  [[ "$lock_wait_ticks" == <-> ]] || lock_wait_ticks=2400
  attempt=0
  while [[ -d "$RUN_DIR/active.lock" ]] && (( attempt < lock_wait_ticks )); do
    sleep 0.1
    (( attempt += 1 ))
  done
  if [[ -d "$RUN_DIR/active.lock" ]]; then
    print "启动进程尚未释放安全锁，正在重新核对运行身份。"
    operator_stop_registered_sessions
  fi
  if [[ -d "$RUN_DIR/active.lock" ]]; then
    print "4 分钟内尚未完成收尾，正在核对并收割经过身份验证的遗留子进程。"
    OPERATOR_ORPHAN_SUPERVISOR_WAIT_TICKS=10 \
    OPERATOR_ORPHAN_WAIT_TICKS=10 \
    OPERATOR_ORPHAN_FORCE_WAIT_TICKS=50 \
      operator_stop_campaign_processes_from_pointer \
        "$DATA_DIR/operator/paper-campaign-latest.json" || true
    attempt=0
    while [[ -d "$RUN_DIR/active.lock" ]] && (( attempt < 100 )); do
      operator_stop_registered_sessions
      [[ -d "$RUN_DIR/active.lock" ]] || break
      sleep 0.1
      (( attempt += 1 ))
    done
    if [[ -d "$RUN_DIR/active.lock" ]]; then
      print "仍未完成收尾。不要手工删除数据库；请把运行窗口内容发给 Codex。"
    else
      print "遗留进程已安全收割，报告整理已结束。"
    fi
  else
    print "已安全暂停，报告已整理。"
  fi
fi

node --import tsx "$PROJECT_ROOT/src/cli/paper-campaign-status.ts" \
  --target-wallet="$TARGET_WALLET" || true
latest_result="$(operator_latest_campaign_result 2>/dev/null || true)"
if [[ "${NI_K_OPERATOR_HEADLESS:-0}" != "1" ]]; then
  if [[ -n "$latest_result" && -e "$latest_result" ]]; then
    open -R "$latest_result" 2>/dev/null || true
  else
    open "$PROJECT_ROOT/交给Codex" 2>/dev/null || true
  fi
fi
pause_if_double_clicked
