#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

RUNTIME_DIR="${RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/vip8-node-hub.pid}"

if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "stopped"
else
  echo "not running"
fi
