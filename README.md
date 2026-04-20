# VIP8 Node Hub

MVP for:
- Telegram 自动采集节点
- TCP 延迟检测
- Base64 订阅生成

## 已支持
- 手动添加节点
- Webhook 接收 Telegram 消息并自动提取：`ss://` `vmess://` `vless://` `trojan://` `hy2://` `hysteria2://`
- 订阅地址：`/sub/<token>`

## 环境变量
复制 `.env.example` 自行填写：

- `PORT=3010`
- `SUB_TOKEN=vip8-demo-token`
- `TG_BOT_TOKEN=` Telegram Bot Token
- `TG_WEBHOOK_SECRET=` Telegram webhook secret
- `TG_ALLOW_CHAT_IDS=` 允许采集的 chat id，多个用逗号分隔
- `PUBLIC_BASE_URL=https://sub.vip8.tech`

## 设置 webhook
```bash
cd /root/.openclaw/workspace/vip8-node-hub
TG_BOT_TOKEN=xxx TG_WEBHOOK_SECRET=yyy PUBLIC_BASE_URL=https://sub.vip8.tech node scripts/set-webhook.js
```

## Telegram 使用建议
1. 先创建一个你自己的群
2. 把 Bot 拉进群
3. 给 Bot 管理员权限（如果要读频道/更多消息）
4. 关闭隐私模式，或者让节点以 `@bot` 提及/命令方式发送
5. 把群 chat id 配到 `TG_ALLOW_CHAT_IDS`

## 下一步
- 增加 Telegram 指令：/stats /check /sub
- 定时自动检测全部节点
- 去重规则增强
- Clash/sing-box 订阅导出
- 后台审核和标签系统
