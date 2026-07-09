#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$PROJECT_ROOT/操作入口/lib/common.sh"

title "打开报告文件夹"
open_report_folders
latest_files_hint
pause_if_double_clicked

