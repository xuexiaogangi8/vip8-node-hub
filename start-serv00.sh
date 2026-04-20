#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ ! -d ./.venv ] && [ ! -d ./node_modules ]; then
  echo "Tip: run 'npm install' first"
fi

export RUNTIME_DIR="${RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
export LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
export PID_FILE="${PID_FILE:-$RUNTIME_DIR/vip8-node-hub.pid}"
export LOG_FILE="${LOG_FILE:-$LOG_DIR/vip8-node-hub.out.log}"

exec ./start.sh
