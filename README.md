# VIP8 Node Hub

一个基于 Node.js + SQLite 的订阅站，支持：

- 会员系统 / 后台管理
- 订阅链接生成与重置
- Telegram 节点采集
- 节点自动检测
- 会员到期 / 未开通自动关闭订阅

## 目录结构

```bash
vip8-node-hub/
├── src/
├── scripts/
├── data/
├── package.json
├── .env.example
├── .gitignore
├── install.sh
├── update.sh
├── backup.sh
└── README.md
```

## 环境要求

- Ubuntu / Debian
- Node.js
- npm
- SQLite3
- systemd

## 快速部署

### 方式一：交互式安装（推荐）

```bash
git clone git@github.com:xuexiaogangi8/vip8-node-hub.git /opt/vip8-node-hub
cd /opt/vip8-node-hub
bash install.sh
```

脚本会一步步询问：
- 站点名称
- 域名
- 对外地址
- 后台密码
- 是否启用 Nginx / HTTPS / UFW
- 是否启用 Telegram / SMTP

在真正安装前，还会显示一份“最终配置摘要”，让你确认后再继续。

如果系统源里的 Node.js 安装失败，脚本会自动尝试使用 NodeSource 安装 `nodejs`。

### 方式二：静默式安装（传环境变量）

```bash
REPO_URL=git@github.com:xuexiaogangi8/vip8-node-hub.git \
APP_DIR=/opt/vip8-node-hub \
BRANCH=main \
PORT=3010 \
PUBLIC_BASE_URL=https://your-domain.example.com \
bash install.sh
```

### 方式三：带 Nginx 反代的生产部署

```bash
REPO_URL=git@github.com:xuexiaogangi8/vip8-node-hub.git \
APP_DIR=/opt/vip8-node-hub \
BRANCH=main \
PORT=3010 \
SETUP_NGINX=1 \
DOMAIN=your-domain.example.com \
PUBLIC_BASE_URL=https://your-domain.example.com \
INSTALL_UFW=1 \
bash install.sh
```

### 方式四：带 HTTPS 的完整生产部署

```bash
REPO_URL=git@github.com:xuexiaogangi8/vip8-node-hub.git \
APP_DIR=/opt/vip8-node-hub \
BRANCH=main \
PORT=3010 \
SETUP_NGINX=1 \
ENABLE_HTTPS=1 \
DOMAIN=your-domain.example.com \
PUBLIC_BASE_URL=https://your-domain.example.com \
LETSENCRYPT_EMAIL=you@example.com \
INSTALL_UFW=1 \
bash install.sh
```

## install.sh 支持的参数

脚本支持两种模式：

- **交互式**：默认在 TTY 下、且未提供关键环境变量时自动进入
- **静默式**：传入环境变量后直接执行

也可以手动指定：

- `INTERACTIVE=1`：强制交互模式
- `INTERACTIVE=0`：强制静默模式

可以通过环境变量控制安装行为：

- `APP_DIR`：安装目录，默认 `/opt/vip8-node-hub`
- `SERVICE_NAME`：systemd 服务名，默认 `vip8-node-hub`
- `APP_USER` / `APP_GROUP`：运行服务的用户/组，默认 `root`
- `REPO_URL`：仓库地址；提供后脚本可自动 clone / pull
- `BRANCH`：Git 分支，默认 `main`
- `PORT`：应用监听端口，默认 `3010`
- `PUBLIC_BASE_URL`：写入 `.env` 的公开访问地址
- `SETUP_NGINX=1`：自动安装并配置 Nginx 反代
- `DOMAIN`：Nginx / HTTPS 使用的域名
- `ENABLE_HTTPS=1`：自动安装 certbot 并申请 Let's Encrypt 证书
- `LETSENCRYPT_EMAIL`：申请证书时使用的邮箱
- `INSTALL_UFW=1`：自动安装并配置 UFW
- `REQUIRE_TELEGRAM=1`：强制检查 Telegram 相关环境变量是否已填写
- `REQUIRE_SMTP=1`：强制检查 SMTP 相关环境变量是否已填写

## 常用命令

### 启动/重启服务
```bash
systemctl restart vip8-node-hub
```

### 查看状态
```bash
systemctl status vip8-node-hub --no-pager
```

### 查看日志
```bash
journalctl -u vip8-node-hub -n 100 --no-pager
```

### 更新代码
```bash
bash update.sh
```

### 备份数据库
```bash
bash backup.sh
```

## 环境变量

复制 `.env.example` 为 `.env` 后填写。

### install.sh 默认强制检查
以下字段在安装时会被检查，不允许为空或保持占位值：

- `PORT`
- `PUBLIC_BASE_URL`
- `SITE_PASSWORD`
- `SITE_SESSION_SECRET`
- `MEMBER_SESSION_SECRET`

### 站点名称

- `SITE_NAME`：站点显示名称

如果未填写，系统会回退为 `PUBLIC_BASE_URL` 的域名。
该名称会用于：

- 页面 `<title>`
- 登录页标题
- 管理后台标题
- 邮箱验证码标题
- 邮件发件显示名（当 `SMTP_FROM` 留空或仅填邮箱时）

### 前台文案覆盖

可以通过 `.env` 覆盖常见前台文案，例如：

- `UI_MEMBER_CENTER`
- `UI_MEMBER_REGISTER`
- `UI_MEMBER_LOGIN`
- `UI_ADMIN_LOGIN`
- `UI_ADMIN_PANEL`
- `UI_REGISTER_EMAIL_TITLE`
- `UI_REGISTER_HINT`
- `UI_EXISTING_ACCOUNT_LINK`
- `UI_NO_ACCOUNT_LINK`
- `UI_ADMIN_ENTRY_LINK`
- `UI_BACK_TO_MEMBER_LOGIN`
- `UI_REGISTER_FAILED`
- `UI_LOGIN_FAILED`
- `UI_ADMIN_LOGIN_FAILED`
- `UI_RETRY_LINK`
- `UI_CENTER_WELCOME`
- `UI_LOGOUT`

### 可选强制检查
如果你在安装时带上下面参数，脚本会额外校验：

- `REQUIRE_TELEGRAM=1`
  - `TG_BOT_TOKEN`
  - `TG_WEBHOOK_SECRET`
- `REQUIRE_SMTP=1`
  - `SMTP_HOST`
  - `SMTP_PORT`
  - `SMTP_USER`
  - `SMTP_PASS`
  - `SMTP_FROM`

## 自动订阅状态规则

系统会自动同步订阅开关：

- 用户 `status != active` → 订阅关闭
- `membership_expires_at` 为空 → 订阅关闭
- `membership_expires_at` 已过期 → 订阅关闭
- 只有 `active` 且未过期 → 订阅开启

默认每 60 秒自动同步一次。

## GitHub 推送注意

仓库已通过 `.gitignore` 排除了这些敏感或不应提交的内容：

- `.env`
- SQLite 数据库文件
- `node_modules`
- 日志文件
- 大音频文件（如 `.flac`）

## 建议

生产环境建议：

- 定期执行 `backup.sh`
- 修改 `.env` 中所有默认密钥
- 配置反向代理（Nginx / Caddy）
- 配置 HTTPS
