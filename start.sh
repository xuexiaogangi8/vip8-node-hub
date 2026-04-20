#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ -f ./.env.runtime ]; then
  set -a
  . ./.env.runtime
  set +a
fi

RUNTIME_DIR="${RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/vip8-node-hub.pid}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/vip8-node-hub.out.log}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    echo "already running: $pid"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup "$NODE_BIN" src/server.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "started: $(cat "$PID_FILE")"
echo "log: $LOG_FILE"
