#!/bin/zsh
set -eu

project_root="$1"
ready_file="$2"
done_file="$3"
output_file="$4"
error_file="$5"

PROJECT_ROOT="$project_root"
source "$PROJECT_ROOT/操作入口/lib/common.sh"
OPERATOR_HEADLESS_ERROR_FILE="$error_file"

finish_after_hangup() {
  cd "$PROJECT_ROOT"
  operator_headless_node --import tsx \
    "$PROJECT_ROOT/src/cli/redact-diagnostic.ts" provenance "$PROJECT_ROOT" \
    >"$output_file"
  print done >"$done_file"
  exit 0
}

trap finish_after_hangup HUP
print $$ >"$ready_file"
while true; do
  sleep 1
done
