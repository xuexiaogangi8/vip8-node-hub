# VIP8 Node Hub 部署文档

这份文档专门说明如何把 `vip8-node-hub` 部署到一台新的服务器，以及如何避免常见报错。

---

## 一、推荐环境

建议统一使用：

- Ubuntu / Debian
- Node.js **22 LTS**
- npm
- systemd
- Nginx（正式环境推荐）

> 不建议不同服务器混用 Node 22 / 24 等不同大版本。

---

## 二、首次部署

### 1. 安装基础工具

```bash
apt update
apt install -y git curl build-essential python3 make g++
```

---

### 2. 拉取仓库

```bash
git clone <你的仓库地址> /opt/vip8-node-hub
cd /opt/vip8-node-hub
```

---

### 3. 安装依赖

```bash
rm -rf node_modules
npm install
```

> **不要复用旧机器拷贝过来的 `node_modules`。**

---

### 4. 运行安装脚本

```bash
bash install.sh
```

安装时会让你填写：

- 站点名称
- 域名
- 对外地址
- 后台密码
- 是否启用 Nginx / HTTPS / UFW
- 是否启用 Telegram / SMTP

---

## 三、配置填写规则

### 场景 A：正式环境（推荐）

如果你要正式对外提供服务，推荐这样配：

- **Nginx：开启**
- **HTTPS：开启**
- **域名：填写真实域名**，例如：
  ```text
  unde.me
  ```
- **对外地址：填写完整 https 地址**，例如：
  ```text
  https://unde.me
  ```

### 场景 B：临时测试环境

如果你只是临时测试，且不想先折腾 Nginx / HTTPS：

- **Nginx：关闭**
- **HTTPS：关闭**
- **域名：填写纯 IP**，例如：
  ```text
  4.190.168.97
  ```
- **对外地址：填写完整 http 地址并带端口**，例如：
  ```text
  http://4.190.168.97:3010
  ```

### 常见错误写法

错误示例：

```text
域名: http://4.190.168.97:3010
对外地址: https://http://4.190.168.97:3010
对外地址: https://4.190.168.97
```

原因：

- 域名字段不应该带协议和端口
- 没开 HTTPS 时不能写 `https://`
- 没开 Nginx 时访问入口就是 `http://IP:3010`

---

## 四、启动后的检查

### 查看服务状态

```bash
systemctl status vip8-node-hub --no-pager
```

### 查看日志

```bash
journalctl -u vip8-node-hub -n 100 --no-pager
```

### 本机测试

```bash
curl -I http://127.0.0.1:3010
```

### 外网测试（测试环境）

```text
http://服务器IP:3010
```

### 外网测试（正式环境）

```text
https://你的域名
```

---

## 五、常见报错与解决方法

### 1. better-sqlite3 Node 版本不匹配

典型报错：

```text
was compiled against a different Node.js version
NODE_MODULE_VERSION xxx
```

原因：

- `better-sqlite3` 是原生模块
- 它和当前机器 / 当前 Node 版本绑定
- 旧环境编译的 `node_modules` 不能直接拿到新环境复用

解决：

```bash
cd /opt/vip8-node-hub
rm -rf node_modules package-lock.json
npm install
systemctl restart vip8-node-hub
```

---

### 2. 服务启动了但外网打不开

检查顺序：

#### 本机是否正常

```bash
curl -I http://127.0.0.1:3010
```

#### 云安全组是否放行端口

如果是测试环境，确认放行：

- TCP `3010`

如果是正式环境，确认放行：

- TCP `80`
- TCP `443`

#### 系统防火墙是否拦截

```bash
ufw status
```

如果启用了 UFW，则放行：

```bash
ufw allow 3010/tcp
```

或正式环境：

```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

---

### 3. 代码错误导致服务启动失败

例如之前出现过：

```text
ReferenceError: Cannot access 'SITE_NAME' before initialization
```

建议每次改完代码后先本地试启动：

```bash
cd /opt/vip8-node-hub
npm start
```

确认无报错后，再交给 systemd：

```bash
systemctl restart vip8-node-hub
```

---

## 六、更新部署流程（推荐）

以后更新代码，不要直接把整个旧目录覆盖掉。

统一用下面流程：

```bash
cd /opt/vip8-node-hub
git pull
rm -rf node_modules
npm install
systemctl restart vip8-node-hub
systemctl status vip8-node-hub --no-pager
```

> 即使只是更新 JS 代码，保险起见也建议重新安装依赖。

---

## 七、数据迁移流程

如果要把旧站迁移到新服务器：

### 代码

- 从 GitHub 重新拉取

### 数据

只迁移：

- `.env`
- `data/app.db`

### 不要迁移

不要迁移：

- `node_modules/`

---

## 八、标准运维原则

记住这句就够了：

> **换服务器 / 升 Node / 恢复备份后，一定删除 `node_modules` 再重新 `npm install`。**

标准修复命令：

```bash
cd /opt/vip8-node-hub
rm -rf node_modules
npm install
systemctl restart vip8-node-hub
journalctl -u vip8-node-hub -n 50 --no-pager
```

---

## 九、推荐部署命令汇总

### 首次部署

```bash
apt update
apt install -y git curl build-essential python3 make g++
git clone <repo> /opt/vip8-node-hub
cd /opt/vip8-node-hub
rm -rf node_modules
npm install
bash install.sh
```

### 更新部署

```bash
cd /opt/vip8-node-hub
git pull
rm -rf node_modules
npm install
systemctl restart vip8-node-hub
```

### 日志排查

```bash
journalctl -u vip8-node-hub -n 100 --no-pager
```
