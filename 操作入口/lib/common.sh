#!/bin/zsh
set -euo pipefail

TARGET_WALLET="0x0c0e270cf879583d6a0142fc817e05b768d0434e"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"

DATA_DIR="$PROJECT_ROOT/data"
LOG_DIR="$DATA_DIR/operator/logs"
mkdir -p "$LOG_DIR"

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
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
    print "当前 Node 版本过低：$(node -v)"
    print "需要 Node.js 24 或以上。"
    exit 1
  fi
  print "Node: $(node -v)"

  if ! command -v pnpm >/dev/null 2>&1; then
    print "未找到 pnpm。请先安装 pnpm，或在 Terminal 中运行：corepack enable"
    exit 1
  fi
  print "pnpm: $(pnpm -v)"

  if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
    title "首次运行，正在安装依赖"
    pnpm install
  fi
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
