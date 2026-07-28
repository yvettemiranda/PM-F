#!/bin/zsh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${OPERATOR_UI_PORT:-4173}"
UI_URL="http://127.0.0.1:${PORT}/"
SNAPSHOT_URL="${UI_URL}api/operator/snapshot"

ui_ready() {
  /usr/bin/curl -fsS --max-time 1 "$SNAPSHOT_URL" >/dev/null 2>&1
}

if ui_ready; then
  /usr/bin/open "$UI_URL"
  print "Hecatonchires 已在运行，已打开现有控制台：$UI_URL"
  exit 0
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
    /usr/bin/open "$UI_URL"
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
