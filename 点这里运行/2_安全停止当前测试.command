#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$PROJECT_ROOT/操作入口/3_停止当前运行.command"
