#!/usr/bin/env bash
set -euo pipefail

APP_NAME="vip8-node-hub"
APP_DIR="${APP_DIR:-/opt/vip8-node-hub}"
SERVICE_NAME="${SERVICE_NAME:-vip8-node-hub}"
APP_USER="${APP_USER:-root}"
APP_GROUP="${APP_GROUP:-root}"
NPM_BIN="${NPM_BIN:-/usr/bin/npm}"
PORT="${PORT:-3010}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
SETUP_NGINX="${SETUP_NGINX:-0}"
DOMAIN="${DOMAIN:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
INSTALL_UFW="${INSTALL_UFW:-0}"
ENABLE_HTTPS="${ENABLE_HTTPS:-0}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
REQUIRE_TELEGRAM="${REQUIRE_TELEGRAM:-0}"
REQUIRE_SMTP="${REQUIRE_SMTP:-0}"
INTERACTIVE="${INTERACTIVE:-auto}"

log() { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err() { echo -e "\033[1;31m[err]\033[0m $*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1"; exit 1; }; }
random_secret() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48; }
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s#^${key}=.*#${key}=${value}#" .env
  else
    echo "${key}=${value}" >> .env
  fi
}
get_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1==key {sub(/^[^=]*=/, ""); print; exit}' .env 2>/dev/null || true
}
require_env_nonempty() {
  local key="$1" value
  value="$(get_env_value "$key")"
  if [ -z "$value" ]; then
    err ".env 缺少必填项: $key"
    return 1
  fi
  return 0
}
require_env_not_placeholder() {
  local key="$1" value
  value="$(get_env_value "$key")"
  if [ -z "$value" ]; then
    err ".env 缺少必填项: $key"
    return 1
  fi
  if echo "$value" | grep -Eq '^(change_me|change_me_to_|your_|example\.com|https://your-domain\.example\.com$)'; then
    err ".env 中 $key 还是占位值，请改成真实值"
    return 1
  fi
  return 0
}
validate_env() {
  local failed=0
  require_env_nonempty PORT || failed=1
  require_env_not_placeholder PUBLIC_BASE_URL || failed=1
  require_env_not_placeholder SITE_NAME || failed=1
  require_env_not_placeholder SITE_PASSWORD || failed=1
  require_env_not_placeholder SITE_SESSION_SECRET || failed=1
  require_env_not_placeholder MEMBER_SESSION_SECRET || failed=1

  if [ "$SETUP_NGINX" = "1" ]; then
    require_env_nonempty DOMAIN || failed=1
  fi

  if [ "$ENABLE_HTTPS" = "1" ]; then
    require_env_nonempty LETSENCRYPT_EMAIL || failed=1
  fi

  if [ "$REQUIRE_TELEGRAM" = "1" ]; then
    require_env_nonempty TG_BOT_TOKEN || failed=1
    require_env_nonempty TG_WEBHOOK_SECRET || failed=1
  fi

  if [ "$REQUIRE_SMTP" = "1" ]; then
    require_env_nonempty SMTP_HOST || failed=1
    require_env_nonempty SMTP_PORT || failed=1
    require_env_nonempty SMTP_USER || failed=1
    require_env_nonempty SMTP_PASS || failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    err ".env 校验失败，请先修正后再继续。"
    exit 1
  fi
}

ask() {
  local var="$1" prompt="$2" default="${3:-}" secret="${4:-0}" answer=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$secret" = "1" ]; then
    read -r -s -p "$prompt${default:+ [$default]}: " answer
    echo
  else
    read -r -p "$prompt${default:+ [$default]}: " answer
  fi
  answer="${answer:-$default}"
  printf -v "$var" '%s' "$answer"
}

ask_yes_no() {
  local var="$1" prompt="$2" default_bool="${3:-0}" answer=""
  if [ -n "${!var:-}" ] && [[ "${!var}" =~ ^[01]$ ]]; then return; fi
  local hint="[y/N]"
  [ "$default_bool" = "1" ] && hint="[Y/n]"
  read -r -p "$prompt $hint: " answer
  answer="${answer:-$([ "$default_bool" = "1" ] && echo y || echo n)}"
  case "$answer" in
    y|Y|yes|YES) printf -v "$var" '1' ;;
    *) printf -v "$var" '0' ;;
  esac
}

show_final_summary() {
  echo
  echo "================ 最终配置摘要 ================"
  echo "安装目录:        $APP_DIR"
  echo "Git 分支:        $BRANCH"
  echo "仓库地址:        ${REPO_URL:-（当前目录 / 手动放置代码）}"
  echo "站点名称:        ${SITE_NAME:-（未设置）}"
  echo "域名:            ${DOMAIN:-（未设置）}"
  echo "对外地址:        ${PUBLIC_BASE_URL:-（未设置）}"
  echo "监听端口:        $PORT"
  echo "Nginx:           $([ "$SETUP_NGINX" = "1" ] && echo '启用' || echo '关闭')"
  echo "HTTPS:           $([ "$ENABLE_HTTPS" = "1" ] && echo '启用' || echo '关闭')"
  echo "UFW:             $([ "$INSTALL_UFW" = "1" ] && echo '启用' || echo '关闭')"
  echo "Telegram:        $([ "$REQUIRE_TELEGRAM" = "1" ] && echo '启用' || echo '关闭')"
  echo "SMTP:            $([ "$REQUIRE_SMTP" = "1" ] && echo '启用' || echo '关闭')"
  echo "服务名:          $SERVICE_NAME"
  echo "运行用户:        $APP_USER:$APP_GROUP"
  echo "后台密码:        $([ -n "${SITE_PASSWORD:-}" ] && echo '已设置' || echo '未设置')"
  echo "后台 Session:    $([ -n "${SITE_SESSION_SECRET:-}" ] && echo '已设置' || echo '未设置')"
  echo "会员 Session:    $([ -n "${MEMBER_SESSION_SECRET:-}" ] && echo '已设置' || echo '未设置')"
  if [ "$ENABLE_HTTPS" = "1" ]; then
    echo "证书邮箱:        ${LETSENCRYPT_EMAIL:-（未设置）}"
  fi
  echo "============================================"
  echo
}

confirm_or_exit() {
  local answer
  read -r -p "确认开始安装？ [Y/n]: " answer
  answer="${answer:-Y}"
  case "$answer" in
    y|Y|yes|YES) ;;
    *)
      warn "已取消安装。"
      exit 0
      ;;
  esac
}

run_interactive() {
  log "进入交互式安装向导"
  ask REPO_URL "仓库地址（可留空，表示当前目录已有代码）" "$REPO_URL"
  ask APP_DIR "安装目录" "$APP_DIR"
  ask BRANCH "Git 分支" "$BRANCH"
  ask SITE_NAME "站点名称" "VIP8 Node Hub"
  ask DOMAIN "站点域名（例如 sub.example.com）" "$DOMAIN"
  if [ -z "$PUBLIC_BASE_URL" ] && [ -n "$DOMAIN" ]; then PUBLIC_BASE_URL="https://${DOMAIN}"; fi
  ask PUBLIC_BASE_URL "对外访问地址" "$PUBLIC_BASE_URL"
  ask PORT "应用端口" "$PORT"
  ask SITE_PASSWORD "后台密码" "" 1
  ask SITE_SESSION_SECRET "后台 Session Secret（回车自动生成）" "$(random_secret)"
  ask MEMBER_SESSION_SECRET "会员 Session Secret（回车自动生成）" "$(random_secret)"
  ask_yes_no SETUP_NGINX "是否安装并配置 Nginx" 1
  ask_yes_no ENABLE_HTTPS "是否启用 HTTPS（Let's Encrypt）" 1
  if [ "$ENABLE_HTTPS" = "1" ]; then
    ask LETSENCRYPT_EMAIL "Let's Encrypt 邮箱" "$LETSENCRYPT_EMAIL"
    SETUP_NGINX=1
  fi
  ask_yes_no INSTALL_UFW "是否启用 UFW 防火墙" 1
  ask_yes_no REQUIRE_TELEGRAM "是否启用 Telegram 功能" 0
  if [ "$REQUIRE_TELEGRAM" = "1" ]; then
    ask TG_BOT_TOKEN "Telegram Bot Token" "$TG_BOT_TOKEN"
    ask TG_WEBHOOK_SECRET "Telegram Webhook Secret（回车自动生成）" "${TG_WEBHOOK_SECRET:-$(random_secret)}"
    ask TG_ALLOW_CHAT_IDS "允许的 Chat ID（可留空）" "$TG_ALLOW_CHAT_IDS"
  fi
  ask_yes_no REQUIRE_SMTP "是否启用 SMTP 发信" 0
  if [ "$REQUIRE_SMTP" = "1" ]; then
    ask SMTP_HOST "SMTP Host" "${SMTP_HOST:-smtp.gmail.com}"
    ask SMTP_PORT "SMTP Port" "${SMTP_PORT:-587}"
    ask SMTP_USER "SMTP 用户名" "$SMTP_USER"
    ask SMTP_PASS "SMTP 密码 / App Password" "$SMTP_PASS" 1
    ask SMTP_FROM "SMTP 发件人（留空则自动用 SITE_NAME <SMTP_USER>）" "$SMTP_FROM"
  fi

  show_final_summary
  confirm_or_exit
}

if [ "${EUID}" -ne 0 ]; then
  err "请用 root 运行 install.sh"
  exit 1
fi

if [ "$INTERACTIVE" = "auto" ]; then
  if [ -t 0 ] && [ -z "$REPO_URL$PUBLIC_BASE_URL$DOMAIN${SITE_NAME:-}${SITE_PASSWORD:-}" ]; then
    INTERACTIVE=1
  else
    INTERACTIVE=0
  fi
fi

if [ "$INTERACTIVE" = "1" ]; then
  run_interactive
fi

export DEBIAN_FRONTEND=noninteractive

log "安装系统依赖"
apt update
apt install -y git curl ca-certificates sqlite3 nodejs npm

if [ "$SETUP_NGINX" = "1" ]; then
  apt install -y nginx
fi

if [ "$ENABLE_HTTPS" = "1" ]; then
  apt install -y certbot python3-certbot-nginx
fi

if [ "$INSTALL_UFW" = "1" ]; then
  apt install -y ufw
fi

need_cmd git
need_cmd curl
need_cmd sqlite3
need_cmd npm
need_cmd node
need_cmd systemctl

log "准备应用目录: ${APP_DIR}"
mkdir -p "$APP_DIR"

if [ -n "$REPO_URL" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    log "检测到现有 Git 仓库，更新代码"
    git -C "$APP_DIR" fetch --all --prune
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    if [ -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 2>/dev/null || true)" ]; then
      warn "$APP_DIR 非空，跳过 git clone；请确认代码已在该目录。"
    else
      log "克隆代码仓库"
      git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    fi
  fi
fi

if [ ! -f "$APP_DIR/package.json" ]; then
  err "未检测到 $APP_DIR/package.json"
  err "请先把项目代码放到 $APP_DIR，或设置 REPO_URL 后重新运行。"
  exit 1
fi

cd "$APP_DIR"

log "创建必要目录"
mkdir -p data logs tmp

if [ ! -f .env ] && [ -f .env.example ]; then
  log "生成 .env"
  cp .env.example .env
fi

set_env_value PORT "$PORT"
[ -n "${SITE_NAME:-}" ] && set_env_value SITE_NAME "$SITE_NAME"
[ -n "$PUBLIC_BASE_URL" ] && set_env_value PUBLIC_BASE_URL "$PUBLIC_BASE_URL"
[ -n "$DOMAIN" ] && set_env_value DOMAIN "$DOMAIN"
[ -n "${SITE_PASSWORD:-}" ] && set_env_value SITE_PASSWORD "$SITE_PASSWORD"
[ -n "${SITE_SESSION_SECRET:-}" ] && set_env_value SITE_SESSION_SECRET "$SITE_SESSION_SECRET"
[ -n "${MEMBER_SESSION_SECRET:-}" ] && set_env_value MEMBER_SESSION_SECRET "$MEMBER_SESSION_SECRET"
[ -n "$LETSENCRYPT_EMAIL" ] && set_env_value LETSENCRYPT_EMAIL "$LETSENCRYPT_EMAIL"

if [ "$REQUIRE_TELEGRAM" = "1" ]; then
  [ -n "${TG_BOT_TOKEN:-}" ] && set_env_value TG_BOT_TOKEN "$TG_BOT_TOKEN"
  [ -n "${TG_WEBHOOK_SECRET:-}" ] && set_env_value TG_WEBHOOK_SECRET "$TG_WEBHOOK_SECRET"
  [ -n "${TG_ALLOW_CHAT_IDS:-}" ] && set_env_value TG_ALLOW_CHAT_IDS "$TG_ALLOW_CHAT_IDS"
fi

if [ "$REQUIRE_SMTP" = "1" ]; then
  [ -n "${SMTP_HOST:-}" ] && set_env_value SMTP_HOST "$SMTP_HOST"
  [ -n "${SMTP_PORT:-}" ] && set_env_value SMTP_PORT "$SMTP_PORT"
  [ -n "${SMTP_USER:-}" ] && set_env_value SMTP_USER "$SMTP_USER"
  [ -n "${SMTP_PASS:-}" ] && set_env_value SMTP_PASS "$SMTP_PASS"
  set_env_value SMTP_FROM "${SMTP_FROM:-}"
fi

validate_env

log "安装 Node 依赖"
"$NPM_BIN" install --production

log "设置目录权限"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
chmod +x "$APP_DIR"/install.sh "$APP_DIR"/update.sh "$APP_DIR"/backup.sh 2>/dev/null || true

log "写入 systemd 服务"
cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=VIP8 Node Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NPM_BIN} start
Restart=always
RestartSec=3
TimeoutStopSec=10
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

if [ "$SETUP_NGINX" = "1" ]; then
  if [ -z "$DOMAIN" ]; then
    warn "SETUP_NGINX=1 但未提供 DOMAIN，跳过 Nginx 配置。"
  else
    log "写入 Nginx 站点配置"
    cat >/etc/nginx/sites-available/${SERVICE_NAME}.conf <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/${SERVICE_NAME}.conf /etc/nginx/sites-enabled/${SERVICE_NAME}.conf
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    systemctl enable nginx
    systemctl restart nginx

    if [ "$ENABLE_HTTPS" = "1" ]; then
      log "申请 Let's Encrypt 证书"
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect
    fi
  fi
fi

if [ "$INSTALL_UFW" = "1" ]; then
  log "配置 UFW"
  ufw allow OpenSSH || true
  if [ "$SETUP_NGINX" = "1" ]; then
    ufw allow 'Nginx Full' || true
  else
    ufw allow "$PORT/tcp" || true
  fi
  ufw --force enable || true
fi

log "启动服务"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2

log "服务状态"
systemctl status "$SERVICE_NAME" --no-pager || true

echo
if [ "$SETUP_NGINX" = "1" ] && [ -n "$DOMAIN" ]; then
  if [ "$ENABLE_HTTPS" = "1" ]; then
    log "HTTPS 已配置完成"
    echo "站点地址: https://${DOMAIN}"
  else
    log "Nginx 已配置完成"
    echo "站点地址: http://${DOMAIN}"
  fi
fi

echo "安装完成。"
echo "常用检查命令："
echo "- systemctl restart ${SERVICE_NAME}"
echo "- systemctl status ${SERVICE_NAME} --no-pager"
echo "- journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
