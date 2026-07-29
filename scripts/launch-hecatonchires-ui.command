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

# Finder 启动 .command 时通常只给 /usr/bin:/bin 等系统 PATH，
# 这时 command -v pnpm 会失败，即使本机已经有可用的 pnpm。
# 先从常见用户安装位置和 Codex 自带运行时中补齐 pnpm，再继续下面的
# Node PATH 推导；这样双击入口和终端入口走同一套依赖探测。
resolve_pnpm() {
  local home_dir="${HOME:-}"
  local candidate
  setopt local_options null_glob
  for candidate in \
    "$home_dir/.local/share/pnpm/pnpm" \
    "$home_dir/Library/pnpm/pnpm" \
    "$home_dir/.cache/codex-runtimes/"*/dependencies/bin/fallback/pnpm \
    "/opt/homebrew/bin/pnpm" \
    "/usr/local/bin/pnpm"; do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}

if ! command -v pnpm >/dev/null 2>&1; then
  PNPM_FALLBACK="$(resolve_pnpm || true)"
  if [[ -n "$PNPM_FALLBACK" ]]; then
    export PATH="$(dirname "$PNPM_FALLBACK"):$PATH"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  print -u2 "找不到 pnpm。请先在项目目录完成依赖安装，再重新双击 Hecatonchires.command。"
  exit 1
fi

# Finder 启动 .command 时可能不会加载交互式 shell 的 PATH。若 pnpm
# 来自一个自带 Node 的运行时，先把同目录的 Node 放入 PATH；普通系统
# 安装的 pnpm 则保持原样。
if ! command -v node >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
  PNPM_NODE_DIR="$(cd "$(dirname "$PNPM_BIN")/../../node/bin" 2>/dev/null && pwd || true)"
  if [[ -n "$PNPM_NODE_DIR" && -x "$PNPM_NODE_DIR/node" ]]; then
    export PATH="$PNPM_NODE_DIR:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  print -u2 "找不到 Node.js。请先安装 Node.js 24.14+，再重新双击 Hecatonchires.command。"
  exit 1
fi

cd "$PROJECT_ROOT"
print "正在启动 Hecatonchires 本地控制台（$UI_URL）……"
pnpm operator:ui &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
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
    wait "$SERVER_PID"
    exit $?
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    print -u2 "控制台启动失败，请查看当前终端中的错误信息。"
    exit 1
  fi

  sleep 0.25
done

print -u2 "等待控制台启动超时，请查看当前终端中的错误信息。"
exit 1
