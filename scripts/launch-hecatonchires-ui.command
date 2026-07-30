#!/bin/zsh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${OPERATOR_UI_PORT:-4173}"
UI_URL="http://127.0.0.1:${PORT}/"
SNAPSHOT_URL="${UI_URL}api/operator/snapshot"

ui_ready() {
  /usr/bin/curl -fsS --max-time 1 "$SNAPSHOT_URL" >/dev/null 2>&1
}

open_ui() {
  local reuse_result
  reuse_result="$(/usr/bin/osascript 2>/dev/null <<APPLESCRIPT
set targetUrl to "$UI_URL"
if application "Google Chrome" is running then
  tell application "Google Chrome"
    repeat with browserWindow in windows
      repeat with tabIndex from 1 to (count of tabs of browserWindow)
        if (URL of tab tabIndex of browserWindow as text) is targetUrl then
          set active tab index of browserWindow to tabIndex
          set index of browserWindow to 1
          activate
          return "reused"
        end if
      end repeat
    end repeat
  end tell
end if
return "missing"
APPLESCRIPT
)" || true
  if [[ "$reuse_result" == "reused" ]]; then
    return 0
  fi
  /usr/bin/open "$UI_URL"
}

if ui_ready; then
  open_ui
  print "Hecatonchires 已在运行，已打开现有控制台：$UI_URL"
  exit 0
fi

# 日常启动只需要已经安装好的 Node 运行时与项目依赖，不应额外依赖
# pnpm。Finder 的 PATH 很精简，因此直接寻找兼容 Node 24.14+。
node_supported() {
  local candidate="$1"
  [[ -x "$candidate" ]] || return 1
  "$candidate" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major === 24 && minor >= 14 ? 0 : 1);
  ' >/dev/null 2>&1
}

resolve_node() {
  local home_dir="${HOME:-}"
  local candidate
  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "$candidate" ]] && node_supported "$candidate"; then
    print -r -- "$candidate"
    return 0
  fi
  setopt local_options null_glob
  for candidate in \
    "$home_dir/.cache/codex-runtimes/"*/dependencies/node/bin/node \
    "$home_dir/.nvm/versions/node/"*/bin/node \
    "$home_dir/.volta/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if node_supported "$candidate"; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  print -u2 "找不到兼容的 Node.js 24.14+。请先安装 Node.js 24，再重新双击 Hecatonchires.command。"
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ ! -f "$PROJECT_ROOT/node_modules/tsx/package.json" ]]; then
  print -u2 "Hecatonchires 的本地依赖尚未安装完整，请先完成一次程序安装。"
  exit 1
fi

cd "$PROJECT_ROOT"
print "正在启动 Hecatonchires 本地控制台（$UI_URL）……"
node --import tsx prototype/live-ui/server.mjs &
SERVER_PID=$!
SERVER_STOPPED=0

cleanup() {
  if [[ "$SERVER_STOPPED" -eq 1 ]]; then
    return
  fi
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for ((stop_attempt = 0; stop_attempt < 100; stop_attempt++)); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_STOPPED=1
        return
      fi
      sleep 0.1
    done
    print -u2 "控制台安全停止超时，正在终止本地服务进程。"
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_STOPPED=1
}

handle_signal() {
  cleanup
  exit 0
}

trap cleanup EXIT
trap handle_signal HUP INT TERM

for ((attempt = 0; attempt < 80; attempt++)); do
  if ui_ready; then
    open_ui
    print "控制台已打开：$UI_URL"
    if wait "$SERVER_PID"; then
      SERVER_STATUS=0
    else
      SERVER_STATUS=$?
    fi
    SERVER_STOPPED=1
    exit "$SERVER_STATUS"
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    print -u2 "控制台启动失败，请查看当前终端中的错误信息。"
    exit 1
  fi

  sleep 0.25
done

print -u2 "等待控制台启动超时，请查看当前终端中的错误信息。"
exit 1
