#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$PROJECT_ROOT/交给Codex"
mkdir -p "$RESULTS_DIR"
typeset -a result_files
result_files=("$RESULTS_DIR"/发给Codex_*(Nom))

print "这里保存系统自动整理好的验证结果。"
print "测试结束后，请把最新的 发给Codex_日期时间.zip 发给 Codex。"
if (( ${#result_files[@]} > 0 )); then
  print "Finder 已为你选中最新结果：${result_files[1]:t}"
  open -R "${result_files[1]}" 2>/dev/null || open "$RESULTS_DIR"
else
  print "这里还是空的，说明任务尚未结束或尚未生成报告。"
  open "$RESULTS_DIR"
fi

if [[ -t 0 ]]; then
  print ""
  print "按回车键关闭窗口。"
  read -r _unused || true
fi
