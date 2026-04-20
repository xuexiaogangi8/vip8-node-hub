#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vip8-node-hub}"
SERVICE_NAME="${SERVICE_NAME:-vip8-node-hub}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"

echo "==> 当前目录: $APP_DIR"
echo "==> 拉取代码分支: $BRANCH"

git fetch origin
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  echo "==> 切换到分支: $BRANCH"
  git checkout "$BRANCH"
fi

git pull origin "$BRANCH"

echo "==> 重新安装依赖"
rm -rf node_modules
npm install

echo "==> 重启服务: $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "==> 服务状态"
systemctl status "$SERVICE_NAME" --no-pager || true

echo

echo "==> 最近日志"
journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
