# VIP8 Node Hub on serv00 / FreeBSD

这份说明是给 **serv00（FreeBSD、无 root、无 systemd）** 用的。

## 1. 目录建议

把项目放到你自己的 home 目录，例如：

```sh
cd ~
tar xzf vip8-node-hub.tar.gz
cd vip8-node-hub
```

或直接 git / scp 上传整个目录。

---

## 2. 安装依赖

确保 serv00 已有 Node.js。然后执行：

```sh
cd ~/vip8-node-hub
npm install
```

检查版本：

```sh
node -v
npm -v
```

---

## 3. 配置环境变量

编辑：

```sh
nano .env.runtime
```

至少检查这些：

```env
PORT=3000
PUBLIC_BASE_URL=https://你的域名
SITE_PASSWORD=你的后台密码
SITE_SESSION_SECRET=随便一串长随机字符
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的gmail@gmail.com
SMTP_PASS=你的16位应用专用密码（建议不要带空格）
MAIL_FROM=你的gmail@gmail.com
```

### serv00 注意
- `PORT` 不一定能随便开，按 serv00 给你的可用端口来
- `PUBLIC_BASE_URL` 要写你的最终域名
- 如果 Gmail SMTP 连不通，就要换别的 SMTP

---

## 4. 启动

项目已经改成 **不依赖 root / systemd**。

直接启动：

```sh
cd ~/vip8-node-hub
sh start-serv00.sh
```

停止：

```sh
cd ~/vip8-node-hub
sh stop.sh
```

日志：

```sh
tail -f ~/vip8-node-hub/logs/vip8-node-hub.out.log
```

PID 文件：

```sh
cat ~/vip8-node-hub/runtime/vip8-node-hub.pid
```

---

## 5. 检查是否成功

本机检查：

```sh
fetch -qo - http://127.0.0.1:3000/health
```

如果 serv00 没有 `fetch`，也可用：

```sh
curl http://127.0.0.1:3000/health
```

返回类似：

```json
{"ok":true,"service":"vip8-node-hub"}
```

---

## 6. 域名 / 反代

serv00 一般不是 root，自带自己的 web/代理方式。核心思路是：

- 外部域名 → serv00 提供的 web/反代入口
- 反代到 `127.0.0.1:PORT`

你只要把 serv00 面板里的反向代理目标指向：

```text
127.0.0.1:3000
```

并把 `.env.runtime` 里的：

```env
PUBLIC_BASE_URL=https://你的域名
```

改成实际域名。

---

## 7. Telegram webhook

如果域名已经可访问，再设置 webhook：

```sh
cd ~/vip8-node-hub
set -a
. ./.env.runtime
set +a
node scripts/set-webhook.js
```

---

## 8. serv00 常见坑

### 1) 端口不可用
如果启动失败，先看日志；很多时候是 `PORT` 不是 serv00 允许的端口。

### 2) node 不在 PATH
如果 `start-serv00.sh` 报 `node not found in PATH`，先执行：

```sh
which node
```

然后把路径写进环境：

```sh
export NODE_BIN=/你的/node/路径
sh start-serv00.sh
```

### 3) Gmail 发信失败
查看日志，如果是 SMTP 连接失败，可能是：
- App Password 错了
- Gmail 限制
- serv00 出口网络限制 SMTP

### 4) SQLite 文件权限
确保整个项目目录都在你自己的 home 下，别放到无权限写入的位置。

---

## 9. 推荐迁移文件

至少带这些：

- `src/`
- `data/app.db`
- `.env.runtime`
- `package.json`
- `package-lock.json`
- `start.sh`
- `start-serv00.sh`
- `stop.sh`

---

## 10. 最简部署流程

```sh
cd ~
tar xzf vip8-node-hub.tar.gz
cd vip8-node-hub
npm install
sh start-serv00.sh
tail -f logs/vip8-node-hub.out.log
```

如果健康检查正常，再去 serv00 面板把域名反代到本地端口。
