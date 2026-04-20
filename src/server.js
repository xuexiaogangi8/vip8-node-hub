import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import db from './db.js';
import { sendVerificationEmail } from './mail.js';
import { parseNode } from './parser.js';
import { buildSubscription } from './subscription.js';
import { ingestTelegramUpdate, isTelegramAllowed } from './telegram.js';
import { checkNodeById, startAutoChecker } from './scheduler.js';
import { createSubscription, getSubscriptionByToken, listSubscriptions, resetSubscriptionToken, disableSubscription, enableSubscription, updateSubscriptionToken, deleteSubscription, clearSubscriptionDevices } from './subscriptions.js';
import { addMembershipDays, adminResetUserPassword, authenticateUser, changeOwnPassword, createInviteCode, createMemberSession, createUser, deleteInviteCode, deleteUser, getUserBySessionToken, listInviteCodes, listUsers, logLoginAttempt, membershipActive, recentEmailSendCount, resetUserSubscriptionToken, revokeMemberSession, saveEmailVerificationCode, setInviteCodeStatus, setUserStatus, syncAllUserSubscriptions, verifyEmailCode } from './users.js';

async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const token = process.env.TG_BOT_TOKEN || '';
  if (!token || !chatId || !text) return { ok: false, skipped: true };
  try {
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: !!data?.ok, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function humanizeFetchError(errorText) {
  const text = String(errorText || '');
  if (!text) return '未知抓取错误';
  if (text.startsWith('fetch-dns:')) return `${text}（域名解析失败，可能域名失效或 DNS 异常）`;
  if (text === 'fetch-timeout') return 'fetch-timeout（目标站点响应超时）';
  if (text.startsWith('fetch-tls:')) return `${text}（TLS/证书握手失败）`;
  if (text.startsWith('fetch-connect:')) return `${text}（连接目标站点失败）`;
  if (/^fetch-\d+$/.test(text)) return `${text}（目标站点返回异常状态码）`;
  if (text === 'no-supported-nodes-found') return 'no-supported-nodes-found（内容抓到了，但没识别出支持的节点）';
  return text;
}

function buildTelegramImportNotice(result, checkedRows = [], addedNodes = []) {
  const fetched = (result?.fetched_subscriptions || []).filter((x) => x?.url);
  const fetchErrors = fetched.filter((x) => x?.error);
  const fetchedOk = fetched.filter((x) => !x?.error);
  const doc = result?.telegram_document || null;
  const online = checkedRows.filter((x) => x?.result?.status === 'ok').length;
  const failedChecks = checkedRows.filter((x) => x && x.result && x.result.status !== 'ok').length;
  const total = Number(result?.total || 0);
  const added = Number(result?.added || 0);
  const skipped = Number(result?.skipped || 0);
  const directTotal = Number(result?.direct_total || 0);
  const parseErrors = [...new Set((result?.errors || []).filter(Boolean))];

  let title = 'ℹ️ 入站结果';
  if (added > 0 && fetchedOk.length) title = '✅ 订阅链接入站成功';
  else if (added > 0 && directTotal > 0) title = '✅ 节点入站成功';
  else if (skipped > 0 && total > 0) title = 'ℹ️ 已识别节点，但全部重复';
  else if (fetchErrors.length || doc?.error) title = '⚠️ 识别到链接/文件，但导入失败';
  else if (fetchedOk.length || directTotal > 0 || doc?.count) title = 'ℹ️ 已处理群消息';

  const lines = [title];

  if (fetchedOk.length) {
    lines.push(...fetchedOk.slice(0, 5).map((item, idx) => `${idx + 1}. ${item.url}${item.format ? ` (${item.format})` : ''}${item.count !== undefined ? ` · 识别 ${item.count}` : ''}`));
    if (fetchedOk.length > 5) lines.push(`... 其余 ${fetchedOk.length - 5} 个链接省略`);
  }

  if (doc && (doc.file_name || doc.error || doc.count)) {
    lines.push(`文件：${doc.file_name || 'telegram-document'}${doc.format ? ` (${doc.format})` : ''}${doc.count ? ` · 识别 ${doc.count}` : ''}`);
  }

  if (directTotal > 0) lines.push(`消息内直链节点：${directTotal}`);
  if (total > 0) lines.push(`识别节点总数：${total}`);
  if (added > 0) lines.push(`新增节点：${added}`);
  if (addedNodes.length) {
    lines.push('新增示例：');
    lines.push(...addedNodes.slice(0, 3).map((node) => `- ${(node?.name || `${node?.protocol || 'node'} ${node?.host || ''}:${node?.port || ''}`).trim()}`));
  }
  if (skipped > 0) lines.push(`重复/跳过：${skipped}`);
  if (checkedRows.length) lines.push(`检测在线：${online}`);
  if (failedChecks) lines.push(`检测失败：${failedChecks}`);

  if (fetchErrors.length) {
    lines.push(...fetchErrors.slice(0, 3).map((item) => `抓取失败：${item.url} · ${humanizeFetchError(item.error)}`));
    if (fetchErrors.length > 3) lines.push(`... 其余 ${fetchErrors.length - 3} 个抓取失败省略`);
  }
  if (doc?.error) lines.push(`文件处理失败：${doc.error}`);
  if (parseErrors.length) {
    lines.push(...parseErrors.slice(0, 3).map((err) => `解析失败：${err}`));
    if (parseErrors.length > 3) lines.push(`... 其余 ${parseErrors.length - 3} 个解析错误省略`);
  }
  if (!added && !skipped && !fetchErrors.length && !doc?.error && (fetchedOk.length || directTotal > 0 || doc?.count)) {
    lines.push('可能原因：内容不是可识别订阅，或节点格式不受支持');
  }

  return lines.join('\n');
}

const app = express();
const PORT = process.env.PORT || 3010;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SITE_SESSION_SECRET = process.env.SITE_SESSION_SECRET || 'change-me';
const ADMIN_COOKIE = 'vip8_site_auth';
const MEMBER_COOKIE = 'vip8_member_auth';
const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BG_MUSIC_FILE = path.resolve(APP_ROOT, 'hongzaoshu.flac');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3010}`).replace(/\/$/, '');
const SITE_NAME = String(process.env.SITE_NAME || '').trim() || (() => {
  try { return new URL(PUBLIC_BASE_URL).host || 'VIP8 Node Hub'; } catch { return 'VIP8 Node Hub'; }
})();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const idx = part.indexOf('=');
    return idx === -1 ? [part, ''] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
  }));
}

function adminAuthToken() {
  return crypto.createHash('sha256').update(`${SITE_PASSWORD}:${SITE_SESSION_SECRET}`).digest('hex');
}

function isAdminAuthed(req) {
  if (!SITE_PASSWORD) return true;
  return parseCookies(req)[ADMIN_COOKIE] === adminAuthToken();
}

function memberFromReq(req) {
  const token = parseCookies(req)[MEMBER_COOKIE];
  return token ? getUserBySessionToken(token) : null;
}

function requireAdmin(req, res, next) {
  if (isAdminAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'admin auth required' });
  return res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  const user = memberFromReq(req);
  if (user) {
    req.member = user;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'member auth required' });
  return res.redirect('/login');
}

function latestStatusesMap(nodeIds = []) {
  if (!nodeIds.length) return new Map();
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.node_id, c.status, c.latency_ms, c.checked_at, c.error
    FROM checks c
    JOIN (
      SELECT node_id, MAX(id) AS max_id
      FROM checks
      WHERE node_id IN (${placeholders})
      GROUP BY node_id
    ) latest ON latest.node_id = c.node_id AND latest.max_id = c.id
  `).all(...nodeIds);
  return new Map(rows.map((row) => [row.node_id, row]));
}

function listNodes({ page = 1, pageSize = 100 } = {}) {
  const safePageSize = Math.min(200, Math.max(20, Number(pageSize || 100)));
  const safePage = Math.max(1, Number(page || 1));
  const total = db.prepare(`SELECT COUNT(*) AS count FROM nodes`).get().count || 0;
  const offset = (safePage - 1) * safePageSize;
  const rows = db.prepare(`SELECT * FROM nodes ORDER BY id DESC LIMIT ? OFFSET ?`).all(safePageSize, offset);
  const statusMap = latestStatusesMap(rows.map((row) => row.id));
  return {
    items: rows.map((row) => ({ ...row, last_check: statusMap.get(row.id) || null })),
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
  };
}

function onlineNodesOnly() {
  const rows = db.prepare(`SELECT * FROM nodes WHERE enabled = 1 ORDER BY id DESC`).all();
  const statusMap = latestStatusesMap(rows.map((row) => row.id));
  return rows.filter((row) => statusMap.get(row.id)?.status === 'ok');
}

function resolveNodesForSubscription(sub) {
  const base = (sub?.online_only ?? 1) ? onlineNodesOnly() : db.prepare(`SELECT * FROM nodes WHERE enabled = 1 ORDER BY id DESC`).all();
  const protocols = (sub?.protocol_filter || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return protocols.length ? base.filter((n) => protocols.includes(String(n.protocol).toLowerCase())) : base;
}

function getRequestIp(req) {
  return String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
}

function getDeviceKey(req) {
  const ip = getRequestIp(req);
  const ua = String(req.get('user-agent') || '').trim().slice(0, 300);
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex');
}

function touchSubscriptionDevice(sub, req) {
  const deviceKey = getDeviceKey(req);
  const ip = getRequestIp(req) || null;
  const ua = String(req.get('user-agent') || '').trim().slice(0, 300) || null;
  const existing = db.prepare(`SELECT * FROM subscription_devices WHERE subscription_id = ? AND device_key = ?`).get(sub.id, deviceKey);
  if (existing) {
    db.prepare(`UPDATE subscription_devices SET last_seen_at = CURRENT_TIMESTAMP, hits = hits + 1, ip = ?, user_agent = ? WHERE id = ?`).run(ip, ua, existing.id);
    return { allowed: true, known: true, deviceCount: db.prepare(`SELECT COUNT(*) AS count FROM subscription_devices WHERE subscription_id = ?`).get(sub.id).count || 0 };
  }
  const deviceCount = db.prepare(`SELECT COUNT(*) AS count FROM subscription_devices WHERE subscription_id = ?`).get(sub.id).count || 0;
  const limit = Math.max(1, Number(sub.device_limit || 5));
  if (deviceCount >= limit) return { allowed: false, known: false, deviceCount, limit };
  db.prepare(`INSERT INTO subscription_devices (subscription_id, device_key, ip, user_agent) VALUES (?, ?, ?, ?)`).run(sub.id, deviceKey, ip, ua);
  return { allowed: true, known: false, deviceCount: deviceCount + 1, limit };
}

function conservativeCleanupNodes() {
  const candidateIds = db.prepare(`
    SELECT n.id
    FROM nodes n
    WHERE NOT EXISTS (
      SELECT 1 FROM checks c
      WHERE c.node_id = n.id
        AND c.status = 'ok'
        AND c.checked_at >= datetime('now', '-24 hours')
    )
  `).all().map((row) => row.id);

  if (!candidateIds.length) {
    return { deletedNodes: 0, deletedChecks: 0, remainingNodes: db.prepare(`SELECT COUNT(*) AS count FROM nodes`).get().count || 0 };
  }

  const placeholders = candidateIds.map(() => '?').join(',');
  const deletedChecks = db.prepare(`SELECT COUNT(*) AS count FROM checks WHERE node_id IN (${placeholders})`).get(...candidateIds).count || 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM checks WHERE node_id IN (${placeholders})`).run(...candidateIds);
    db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...candidateIds);
  });
  tx();

  return {
    deletedNodes: candidateIds.length,
    deletedChecks,
    remainingNodes: db.prepare(`SELECT COUNT(*) AS count FROM nodes`).get().count || 0,
  };
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'vip8-node-hub' }));

app.get('/assets/bg-music', (_req, res) => {
  if (!fs.existsSync(BG_MUSIC_FILE)) return res.status(404).send('bg music not found');
  const stat = fs.statSync(BG_MUSIC_FILE);
  res.setHeader('Content-Type', 'audio/flac');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(BG_MUSIC_FILE).pipe(res);
});

app.get('/register', (_req, res) => {
  res.type('html').send(pageWrap('会员注册', authCard(`
    <h2>邮箱注册</h2>
    <p class="muted">邀请码 + 邮箱验证码注册。注册成功后等待后台开通时长。</p>
    <form method="post" action="/register">
      <input name="invite_code" placeholder="邀请码" />
      <div style="height:12px"></div>
      <input id="email" name="email" type="email" placeholder="Gmail 邮箱" />
      <div style="height:12px"></div>
      <div class="sub-actions" style="grid-template-columns:2fr 1fr"><input name="email_code" placeholder="邮箱验证码" /><button type="button" onclick="sendRegisterCode()">发送验证码</button></div>
      <div style="height:12px"></div>
      <input name="password" type="password" placeholder="密码，至少 6 位" />
      <div style="height:12px"></div>
      <button type="submit">注册</button>
    </form>
    <p class="muted"><a href="/login">已有账号，去登录</a> · <a href="/admin/login">管理员入口</a></p>
  `), registerScripts()));
});

app.post('/register', (req, res) => {
  try {
    verifyEmailCode({ email: req.body.email || '', code: req.body.email_code || '', purpose: 'register' });
    createUser({ email: req.body.email || '', password: req.body.password, inviteCode: req.body.invite_code || '' });
    res.redirect('/login?registered=1');
  } catch (error) {
    res.status(400).type('html').send(pageWrap('注册失败', authCard(`<h2>注册失败</h2><p class="muted">${escapeHtml(error.message)}</p><p><a href="/register">返回重试</a></p>`), registerScripts()));
  }
});

app.post('/api/public/send-register-code', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const inviteCode = String(req.body?.inviteCode || '').trim();
    if (!email) throw new Error('请先输入邮箱');
    if (!inviteCode) throw new Error('请先输入邀请码');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确');
    const invite = db.prepare(`SELECT * FROM invite_codes WHERE code = ?`).get(inviteCode);
    if (!invite) throw new Error('邀请码不存在');
    if (!invite.enabled) throw new Error('邀请码已停用');
    if (invite.used_count >= invite.max_uses) throw new Error('邀请码已用完');
    if (db.prepare(`SELECT 1 FROM users WHERE lower(email) = lower(?)`).get(email)) throw new Error('邮箱已被注册');
    if (recentEmailSendCount(email, 'register', 10) >= 3) throw new Error('发送太频繁，请 10 分钟后再试');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await sendVerificationEmail({ to: email, code });
    saveEmailVerificationCode({ email, code, purpose: 'register', ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/login', (_req, res) => {
  res.type('html').send(pageWrap('会员登录', authCard(`
    <h2>会员登录</h2>
    <p class="muted">支持用户名或邮箱登录。</p>
    <form method="post" action="/login">
      <input name="username" placeholder="用户名或邮箱" />
      <div style="height:12px"></div>
      <input name="password" type="password" placeholder="密码" />
      <div style="height:12px"></div>
      <button type="submit">登录</button>
    </form>
    <p class="muted"><a href="/register">没有账号？去注册</a> · <a href="/admin/login">管理员入口</a></p>
  `)));
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const user = authenticateUser(username, req.body.password || '');
  logLoginAttempt({ username, ok: !!user, ip: req.ip, ua: req.get('user-agent'), cfIp: req.get('cf-connecting-ip'), xff: req.get('x-forwarded-for') });
  if (!user) return res.status(401).type('html').send(pageWrap('登录失败', authCard(`<h2>登录失败</h2><p class="muted">用户名/邮箱或密码错误。</p><p><a href="/login">返回重试</a></p>`)));
  const token = createMemberSession(user.id, 30);
  res.setHeader('Set-Cookie', `${MEMBER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  const token = parseCookies(req)[MEMBER_COOKIE];
  if (token) revokeMemberSession(token);
  res.setHeader('Set-Cookie', `${MEMBER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/login');
});

app.get('/admin/login', (_req, res) => {
  res.type('html').send(pageWrap('后台登录', authCard(`
    <h2>${escapeHtml(SITE_NAME)} 管理后台</h2>
    <p class="muted">输入网站后台密码进入管理端。</p>
    <form method="post" action="/admin/login">
      <input type="password" name="password" placeholder="后台密码" autofocus />
      <div style="height:12px"></div>
      <button type="submit">进入后台</button>
    </form>
    <p class="muted"><a href="/login">返回会员登录</a></p>
  `)));
});

app.post('/admin/login', (req, res) => {
  if (!SITE_PASSWORD || String(req.body.password || '') !== SITE_PASSWORD) return res.status(401).type('html').send(pageWrap('后台登录失败', authCard(`<h2>后台登录失败</h2><p class="muted">密码错误。</p><p><a href="/admin/login">返回重试</a></p>`)));
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${adminAuthToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);
  res.redirect('/admin');
});

app.post('/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/admin/login');
});

app.get('/sub/:token', (req, res) => {
  const subConfig = getSubscriptionByToken(req.params.token);
  if (!subConfig) return res.status(403).send('forbidden');
  const deviceGate = touchSubscriptionDevice(subConfig, req);
  if (!deviceGate.allowed) return res.status(403).send(`device limit exceeded (${deviceGate.deviceCount}/${deviceGate.limit})`);
  const nodes = resolveNodesForSubscription(subConfig);
  const sub = buildSubscription(nodes);
  res.type('text/plain').send(sub.base64);
});

app.get('/', requireMember, (req, res) => {
  const user = req.member;
  const sub = user.subscription_id ? db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(user.subscription_id) : null;
  const url = sub ? `${PUBLIC_BASE_URL}/sub/${sub.token}` : '-';
  const expire = user.membership_expires_at ? new Date(user.membership_expires_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' }) + ' UTC' : '未开通';
  const active = membershipActive(user);
  res.type('html').send(pageWrap('会员中心', `
    <div class="wrap">
      <div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><div><h1>会员中心</h1><p class="muted">你的专属订阅在这，会员到期就自动失效。</p></div><form method="post" action="/logout" style="margin:0"><button type="submit" style="width:auto">退出登录</button></form></div></div>
      <div class="grid">
        <div class="card"><h2>账号信息</h2><div class="sub-meta">用户名：<strong>${escapeHtml(user.username)}</strong></div><div class="sub-meta">状态：${active ? '✅ 会员有效' : '❌ 未开通或已到期'}</div><div class="sub-meta">到期时间：${escapeHtml(expire)}</div><div style="height:14px"></div><h2 style="font-size:18px">修改密码</h2><div class="sub-actions" style="grid-template-columns:1fr"><input id="oldPassword" type="password" placeholder="旧密码" /><input id="newPassword" type="password" placeholder="新密码（至少 6 位）" /><button type="button" onclick="changeMyPassword()">修改我的密码</button></div></div>
        <div class="card"><h2>我的订阅</h2>${sub ? `<div class="sub-meta">订阅状态：${sub.enabled ? '启用中' : '已关闭'}</div><input class="sub-url" readonly value="${escapeHtml(url)}" onclick="this.select()" /><div class="copy-hint">点一下自动全选复制</div><div class="sub-actions"><button type="button" onclick="resetMySub()">重置我的订阅地址</button><a href="${url}" target="_blank" class="secondary-btn">查看订阅内容</a></div>` : '<div class="muted">还没有分配订阅。</div>'}</div>
      </div>
    </div>
  `, memberScripts()));
});

app.get('/admin', requireAdmin, (req, res) => {
  const nodePage = listNodes({ page: req.query?.page || 1, pageSize: req.query?.pageSize || 100 });
  const nodes = nodePage.items;
  const total = nodePage.total;
  const online = db.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE enabled = 1`).get().count || 0;
  const subscriptions = listSubscriptions();
  const users = listUsers();
  const invites = listInviteCodes();
  const audits = db.prepare(`SELECT * FROM login_audit ORDER BY id DESC LIMIT 20`).all();
  const avgLatency = (() => {
    const vals = nodes.map((n) => n.last_check?.latency_ms).filter(Boolean);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + ' ms' : '-';
  })();
  const conservativeCleanupCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM nodes n
    WHERE NOT EXISTS (
      SELECT 1 FROM checks c
      WHERE c.node_id = n.id
        AND c.status = 'ok'
        AND c.checked_at >= datetime('now', '-24 hours')
    )
  `).get().count || 0;
  const rows = nodes.map((n) => `<tr><td>${n.id}</td><td>${escapeHtml(n.name || '-')}</td><td>${escapeHtml(n.protocol)}</td><td>${escapeHtml(n.host || '-')}</td><td>${n.port || '-'}</td><td>${n.last_check?.status === 'ok' ? '✅ 在线' : n.last_check ? '❌ 失败' : '⏳ 未检测'}</td><td>${n.last_check?.latency_ms ? n.last_check.latency_ms + ' ms' : '-'}</td><td><button type="button" onclick="deleteNode(${n.id}, '${escapeJs(n.name || '')}')">删除</button></td></tr>`).join('');
  const pager = `<div class="pager"><span class="muted">第 ${nodePage.page} / ${nodePage.totalPages} 页 · 共 ${nodePage.total} 个节点</span><div class="pager-actions"><a class="secondary-btn ${nodePage.page <= 1 ? 'disabled-link' : ''}" href="/admin?page=${Math.max(1, nodePage.page - 1)}&pageSize=${nodePage.pageSize}">上一页</a><a class="secondary-btn ${nodePage.page >= nodePage.totalPages ? 'disabled-link' : ''}" href="/admin?page=${Math.min(nodePage.totalPages, nodePage.page + 1)}&pageSize=${nodePage.pageSize}">下一页</a></div></div>`;
  const subCards = subscriptions.map((s) => {
    const url = `${PUBLIC_BASE_URL}/sub/${s.token}`;
    const owner = users.find((u) => u.subscription_id === s.id);
    return `<div class="sub-card"><div class="sub-head"><strong>${escapeHtml(s.name || '未命名订阅')}</strong><span class="sub-badge">#${s.id}</span></div><div class="sub-meta">状态：${s.enabled ? '启用中' : '已关闭'}</div><div class="sub-meta">归属：${escapeHtml(owner?.username || '未绑定用户')}</div><div class="sub-meta">设备指纹上限：${Number(s.device_limit || 5)} 个</div><div class="sub-meta">已记录指纹：${Number(s.device_count || 0)} 个</div><div class="sub-meta">Token：<code>${escapeHtml(s.token)}</code></div><input value="${escapeHtml(url)}" readonly onclick="this.select()" class="sub-url" /><div class="sub-actions" style="grid-template-columns:1fr 1fr"><button type="button" onclick="resetSub(${s.id}, '${escapeJs(s.name || '')}')">重置订阅</button>${s.enabled ? `<button type="button" onclick="disableSub(${s.id}, '${escapeJs(s.name || '')}')">关闭订阅</button>` : `<button type="button" onclick="enableSub(${s.id}, '${escapeJs(s.name || '')}')">恢复订阅</button>`}<button type="button" onclick="clearSubDevices(${s.id}, '${escapeJs(s.name || '')}')">清空指纹记录</button><button type="button" onclick="deleteSub(${s.id}, '${escapeJs(s.name || '')}')">删除</button></div></div>`;
  }).join('');
  const userRows = users.map((u) => `<tr><td>${u.id}</td><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.email || '-')}</td><td>${escapeHtml(u.status)}</td><td>${u.membership_expires_at ? escapeHtml(u.membership_expires_at) : '-'}</td><td>${escapeHtml(u.subscription_token || '-')}</td><td><div class="user-actions"><button type="button" onclick="extendUser(${u.id}, 30)">+30天</button><button type="button" onclick="extendUser(${u.id}, 90)">+90天</button><button type="button" onclick="copyUserSub('${escapeJs(u.subscription_token || '')}', '${escapeJs(u.username)}')">复制订阅地址</button><button type="button" onclick="forceResetUserSub(${u.id}, '${escapeJs(u.username)}')">强制更新订阅</button><button type="button" onclick="resetUserPassword(${u.id}, '${escapeJs(u.username)}')">改密码</button>${u.status === 'active' ? `<button type="button" onclick="toggleUser(${u.id}, 'disabled')">禁用</button>` : `<button type="button" onclick="toggleUser(${u.id}, 'active')">恢复</button>`}<button type="button" onclick="deleteUserAccount(${u.id}, '${escapeJs(u.username)}')">删除用户</button></div></td></tr>`).join('');
  const inviteRows = invites.map((i) => `<tr><td>${i.id}</td><td><code>${escapeHtml(i.code)}</code></td><td>${escapeHtml(i.note || '-')}</td><td>${i.used_count} / ${i.max_uses}</td><td>${i.enabled ? '启用中' : '已停用'}</td><td><div class="user-actions">${i.enabled ? `<button type="button" onclick="toggleInvite(${i.id}, 0)">停用</button>` : `<button type="button" onclick="toggleInvite(${i.id}, 1)">恢复</button>`}<button type="button" onclick="removeInvite(${i.id}, '${escapeJs(i.code || '')}')">删除</button></div></td></tr>`).join('');
  const auditRows = audits.map((a) => `<tr><td>${escapeHtml(a.created_at)}</td><td>${escapeHtml(a.username || '-')}</td><td>${a.ok ? '成功' : '失败'}</td><td>${escapeHtml(a.cf_connecting_ip || a.x_forwarded_for || a.ip || '-')}</td><td>${escapeHtml((a.user_agent || '-').slice(0, 80))}</td></tr>`).join('');
  res.type('html').send(pageWrap('会员后台', `
    <div class="wrap">
      <div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><div><h1>${escapeHtml(SITE_NAME)} 管理后台</h1><p class="muted">会员制 MVP：注册、登录、开通时长、独立订阅。</p></div><form method="post" action="/admin/logout" style="margin:0"><button type="submit" style="width:auto">退出后台</button></form></div><div class="stats"><div class="stat"><div class="num">${total}</div><div class="muted">节点总数</div></div><div class="stat"><div class="num">${online}</div><div class="muted">在线节点</div></div><div class="stat"><div class="num">${avgLatency}</div><div class="muted">平均延迟</div></div></div></div>
      <div class="grid"><div class="card"><h2>手动添加节点</h2><form method="post" action="/api/nodes" onsubmit="submitForm(event)"><textarea name="raw" rows="6" placeholder="粘贴节点"></textarea><div style="height:12px"></div><button type="submit">添加节点</button></form></div><div class="card"><h2>邀请码管理</h2><form onsubmit="createInvite(event)"><input name="note" placeholder="备注，例如：4月活动码" /><div style="height:12px"></div><input name="maxUses" type="number" min="1" value="1" placeholder="可使用次数" /><div style="height:12px"></div><input name="code" placeholder="自定义邀请码（可空自动生成）" /><div style="height:12px"></div><button type="submit">创建邀请码</button></form><div style="height:14px"></div><table><thead><tr><th>ID</th><th>邀请码</th><th>备注</th><th>用量</th><th>状态</th><th>操作</th></tr></thead><tbody>${inviteRows || '<tr><td colspan="6">暂无邀请码</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>创建独立订阅</h2><form id="subForm" onsubmit="createSub(event)"><input name="name" placeholder="订阅名称" /><div style="height:12px"></div><input name="token" placeholder="自定义 token（可空）" /><div style="height:12px"></div><input name="protocol_filter" placeholder="协议筛选：vless,vmess" /><div style="height:12px"></div><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="online_only" checked style="width:auto;padding:0" /> <span class="muted">只导出在线节点</span></label><div style="height:12px"></div><button id="subSubmitBtn" type="submit">创建订阅</button></form><div id="subResult" class="result-card"></div></div>
      <div class="card"><h2>节点清理</h2><div class="sub-meta">可保守清理：<strong>${conservativeCleanupCount}</strong> 个节点</div><div class="sub-meta">规则：删除最近 24 小时内一次成功都没有的节点。</div><div style="height:12px"></div><div class="sub-actions" style="grid-template-columns:1fr"><button type="button" onclick="runConservativeCleanup()">一键保守清理</button></div></div>
      <div class="card"><h2>会员管理</h2><table><thead><tr><th>ID</th><th>用户名</th><th>邮箱</th><th>状态</th><th>到期时间</th><th>订阅 token</th><th>操作</th></tr></thead><tbody>${userRows || '<tr><td colspan="7">暂无会员</td></tr>'}</tbody></table></div>
      <div class="card"><h2>订阅列表</h2><div class="sub-list">${subCards || '<div class="muted">暂无订阅</div>'}</div></div>
      <div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><h2>节点列表</h2>${pager}</div><table><thead><tr><th>ID</th><th>名称</th><th>协议</th><th>主机</th><th>端口</th><th>状态</th><th>延迟</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="8">暂无节点</td></tr>'}</tbody></table></div>
      <div class="card"><h2>最近登录日志</h2><table><thead><tr><th>时间</th><th>用户名</th><th>结果</th><th>IP</th><th>User-Agent</th></tr></thead><tbody>${auditRows || '<tr><td colspan="5">暂无日志</td></tr>'}</tbody></table></div>
    </div>
  `, adminScripts()));
});

app.post('/api/member/reset-subscription', requireMember, (req, res) => {
  try {
    const row = resetUserSubscriptionToken(req.member.id);
    res.json({ ok: true, item: row });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/member/change-password', requireMember, (req, res) => {
  try {
    changeOwnPassword(req.member.id, req.body?.oldPassword || '', req.body?.newPassword || '');
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/telegram/webhook', async (req, res) => {
  const secret = process.env.TG_WEBHOOK_SECRET || '';
  const headerSecret = req.get('x-telegram-bot-api-secret-token') || '';
  if (secret && headerSecret !== secret) return res.status(403).json({ ok: false, error: 'bad webhook secret' });
  if (!isTelegramAllowed(req.body)) return res.status(403).json({ ok: false, error: 'chat not allowed' });
  const before = new Set(db.prepare(`SELECT id FROM nodes`).all().map((x) => x.id));
  const result = await ingestTelegramUpdate(req.body);
  const after = db.prepare(`SELECT id FROM nodes ORDER BY id DESC LIMIT 500`).all().map((x) => x.id).filter((id) => !before.has(id)).slice(0, Math.max(0, Number(result?.added || 0)));
  const checkedResults = [];
  for (const id of after) checkedResults.push(await checkNodeById(id, Number(process.env.CHECK_TIMEOUT_MS || 3000)));
  const addedNodes = after.length
    ? db.prepare(`SELECT id, name, protocol, host, port FROM nodes WHERE id IN (${after.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 3`).all(...after)
    : [];

  const msg = req.body?.message || req.body?.channel_post || req.body?.edited_message;
  const chatType = String(msg?.chat?.type || '');
  const hasFetchedLinks = Array.isArray(result?.fetched_subscriptions) && result.fetched_subscriptions.some((x) => x?.url);
  const hasFetchErrors = Array.isArray(result?.fetched_subscriptions) && result.fetched_subscriptions.some((x) => x?.error);
  const hasDirectNodes = Number(result?.direct_total || 0) > 0;
  const hasDocument = Number(result?.telegram_document?.count || 0) > 0 || !!result?.telegram_document?.error;
  const shouldNotifyGroup = ['group', 'supergroup'].includes(chatType)
    && (hasFetchedLinks || hasFetchErrors || hasDirectNodes || hasDocument)
    && (Number(result?.added || 0) > 0 || Number(result?.skipped || 0) > 0 || hasFetchErrors || !!result?.telegram_document?.error);
  if (shouldNotifyGroup) {
    const notice = buildTelegramImportNotice(result, checkedResults, addedNodes);
    if (notice) await sendTelegramMessage(msg.chat.id, notice, msg.message_id || null);
  }

  res.json({ ...result, checked: after.length });
});

app.use('/api', requireAdmin);

app.get('/api/nodes', (_req, res) => res.json({ items: listNodes() }));
app.post('/api/nodes', async (req, res) => {
  try {
    const parsed = parseNode(req.body.raw || '');
    const result = db.prepare(`INSERT INTO nodes (source_type, source_ref, name, protocol, raw, dedupe_key, host, port) VALUES (@source_type, @source_ref, @name, @protocol, @raw, @dedupe_key, @host, @port)`).run({ source_type: req.body.source_type || 'manual', source_ref: req.body.source_ref || null, ...parsed });
    const id = Number(result.lastInsertRowid);
    const checked = await checkNodeById(id, Number(process.env.CHECK_TIMEOUT_MS || 3000));
    res.json({ ok: true, id, node: parsed, check: checked?.result || null });
  } catch (error) {
    const message = String(error.message || '');
    res.status(400).json({ ok: false, error: message.includes('nodes.dedupe_key') ? '重复节点：同协议、同主机、同端口的节点已存在' : error.message });
  }
});
app.delete('/api/nodes/:id', (req, res) => {
  const node = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(req.params.id);
  if (!node) return res.status(404).json({ ok: false, error: 'Node not found' });
  db.prepare(`DELETE FROM checks WHERE node_id = ?`).run(node.id);
  db.prepare(`DELETE FROM nodes WHERE id = ?`).run(node.id);
  res.json({ ok: true, id: node.id, name: node.name || null });
});
app.post('/api/nodes/cleanup-conservative', (_req, res) => {
  try {
    const result = conservativeCleanupNodes();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});
app.get('/api/subscriptions', (_req, res) => res.json({ items: listSubscriptions() }));
app.post('/api/subscriptions', (req, res) => {
  try { res.json({ ok: true, item: createSubscription({ name: req.body.name || null, token: req.body.token || null, online_only: req.body.online_only === false || req.body.online_only === 0 ? 0 : 1, protocol_filter: req.body.protocol_filter || null }) }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/api/subscriptions/:id/reset', (req, res) => respondSub(res, () => resetSubscriptionToken(Number(req.params.id))));
app.post('/api/subscriptions/:id/disable', (req, res) => respondSub(res, () => disableSubscription(Number(req.params.id))));
app.post('/api/subscriptions/:id/enable', (req, res) => respondSub(res, () => enableSubscription(Number(req.params.id))));
app.post('/api/subscriptions/:id/update-token', (req, res) => respondSub(res, () => updateSubscriptionToken(Number(req.params.id), req.body?.token || '')));
app.post('/api/subscriptions/:id/clear-devices', (req, res) => respondSub(res, () => clearSubscriptionDevices(Number(req.params.id))));
app.delete('/api/subscriptions/:id', (req, res) => respondSub(res, () => deleteSubscription(Number(req.params.id))));
app.post('/api/users/:id/extend', (req, res) => {
  try { res.json({ ok: true, item: addMembershipDays(Number(req.params.id), Number(req.body?.days || 0)) }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/api/users/:id/status', (req, res) => {
  try { res.json({ ok: true, item: setUserStatus(Number(req.params.id), req.body?.status || 'active') }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/api/users/:id/password', (req, res) => {
  try { adminResetUserPassword(Number(req.params.id), req.body?.newPassword || ''); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/api/users/:id/reset-subscription', (req, res) => {
  try {
    const item = resetUserSubscriptionToken(Number(req.params.id));
    res.json({ ok: true, item, url: `${PUBLIC_BASE_URL}/sub/${item.token}` });
  }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.delete('/api/users/:id', (req, res) => {
  try {
    const item = deleteUser(Number(req.params.id));
    if (!item) return res.status(404).json({ ok: false, error: '用户不存在' });
    res.json({ ok: true, item: { id: item.id, username: item.username } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});
app.post('/api/invite-codes', (req, res) => {
  try { res.json({ ok: true, item: createInviteCode({ note: req.body?.note || null, maxUses: req.body?.maxUses || 1, code: req.body?.code || null }) }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/api/invite-codes/:id/status', (req, res) => {
  try { res.json({ ok: true, item: setInviteCodeStatus(Number(req.params.id), Number(req.body?.enabled || 0)) }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.delete('/api/invite-codes/:id', (req, res) => {
  try {
    const item = deleteInviteCode(Number(req.params.id));
    if (!item) return res.status(404).json({ ok: false, error: '邀请码不存在' });
    res.json({ ok: true, item });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

function respondSub(res, fn) {
  try {
    const row = fn();
    if (!row) return res.status(404).json({ ok: false, error: 'Subscription not found' });
    res.json({ ok: true, item: row });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
}

function baseStyles() {
  return `<style>
    body{font-family:Inter,system-ui,sans-serif;background:linear-gradient(135deg,#fffaf2 0%,#ffe7f0 36%,#e6f3ff 100%);color:#25324a;margin:0;padding:32px}.wrap{max-width:1100px;margin:0 auto}.card{background:#ffffffcc;border:1px solid #ffffffaa;backdrop-filter:blur(14px);border-radius:24px;padding:24px;margin-bottom:20px;box-shadow:0 20px 60px #d29ac422}h1,h2{margin:0 0 12px}.muted{color:#6b7280}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:18px}.stat{padding:18px;border-radius:18px;background:#fff;border:1px solid #e8dff1}.num{font-size:28px;font-weight:700}textarea,input,button{width:100%;padding:14px 16px;border-radius:14px;border:1px solid #d7ddeb;background:#fff;color:#25324a;box-sizing:border-box}button{background:linear-gradient(135deg,#ff96b7,#8bbdff);border:none;font-weight:700;cursor:pointer;color:#fff}.sub-list{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.sub-card{padding:16px;border-radius:16px;background:#fff;border:1px solid #eadff0}.sub-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:10px}.sub-badge{font-size:12px;color:#7b8496}.sub-meta{font-size:14px;color:#475569;margin-bottom:6px;word-break:break-word}.sub-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.user-actions{display:grid;grid-template-columns:repeat(2,minmax(110px,1fr));gap:8px;align-items:stretch}.user-actions button{width:auto;min-height:44px;padding:10px 12px;font-size:13px;line-height:1.2}.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.pager-actions{display:flex;gap:8px;flex-wrap:wrap}.disabled-link{pointer-events:none;opacity:.45}.sub-url{margin-top:10px;margin-bottom:10px}.copy-hint{font-size:13px;color:#7b8496}.secondary-btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 14px;border-radius:14px;background:#fff;color:#44506a;text-decoration:none;border:1px solid #d9e2f2;font-weight:700}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #eadff0;text-align:left;font-size:14px;vertical-align:top}.result-card{display:none;margin-top:16px;padding:16px;border-radius:16px;background:#fff;border:1px solid #eadff0}.result-card.show{display:block}@media(max-width:800px){.grid,.sub-list,.stats,.user-actions{grid-template-columns:1fr}body{padding:16px}}</style>`;
}
function pageWrap(title, body, scripts = '') { return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escapeHtml(title)}</title>${baseStyles()}</head><body>${body}${scripts}</body></html>`; }
function authCard(inner) { return `<div class="wrap" style="max-width:420px"><div class="card">${inner}</div></div>`; }
function registerScripts() { return `<script>
  async function readJsonSafe(resp){const text=await resp.text();try{return JSON.parse(text);}catch(_){throw new Error(text||('HTTP '+resp.status));}}
  async function sendRegisterCode(){const email=document.getElementById('email')?.value||'';const inviteCode=document.querySelector('input[name=\"invite_code\"]')?.value||'';if(!email){alert('请先输入邮箱');return;}if(!inviteCode){alert('请先输入邀请码');return;}const r=await fetch('/api/public/send-register-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,inviteCode})});const j=await readJsonSafe(r);alert(j.ok?'验证码已发送，请查收邮箱':'失败: '+j.error);}
</script>`; }
function memberScripts() { return `<script>
  async function readJsonSafe(resp){const text=await resp.text();try{return JSON.parse(text);}catch(_){throw new Error(text||('HTTP '+resp.status));}}
  async function resetMySub(){if(!confirm('确认重置你的订阅地址吗？旧地址会立刻失效。')) return;const r=await fetch('/api/member/reset-subscription',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?('新的订阅地址: ${escapeJs(PUBLIC_BASE_URL)}/sub/'+j.item.token):('失败: '+j.error));if(j.ok) location.reload();}
  async function changeMyPassword(){const oldPassword=document.getElementById('oldPassword')?.value||'';const newPassword=document.getElementById('newPassword')?.value||'';if(!oldPassword||!newPassword){alert('请先输入旧密码和新密码');return;}const r=await fetch('/api/member/change-password',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({oldPassword,newPassword})});const j=await readJsonSafe(r);alert(j.ok?'密码已修改':'失败: '+j.error);if(j.ok){document.getElementById('oldPassword').value='';document.getElementById('newPassword').value='';}}
</script>`; }
function adminScripts() { return `<script>
  async function readJsonSafe(resp){const text=await resp.text();try{return JSON.parse(text);}catch(_){throw new Error(text||('HTTP '+resp.status));}}
  async function submitForm(e){e.preventDefault();const fd=new FormData(e.target);const payload=Object.fromEntries(fd.entries());const r=await fetch('/api/nodes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'添加成功':'失败: '+j.error);if(j.ok) location.reload();}
  async function createSub(e){e.preventDefault();const form=e.target;const fd=new FormData(form);const payload=Object.fromEntries(fd.entries());payload.online_only = fd.get('online_only') ? 1 : 0;const r=await fetch('/api/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'创建成功':'失败: '+j.error);if(j.ok) location.reload();}
  async function deleteNode(id,name){if(!confirm('确认删除 '+(name||('节点 #'+id))+' 吗？')) return;const r=await fetch('/api/nodes/'+id,{method:'DELETE',credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'已删除':'失败: '+j.error);if(j.ok) location.reload();}
  async function runConservativeCleanup(){if(!confirm('确认执行保守清理吗？\\n会删除最近 24 小时内一次成功都没有的节点。')) return;const r=await fetch('/api/nodes/cleanup-conservative',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?('已清理 '+j.deletedNodes+' 个节点，删掉 '+j.deletedChecks+' 条检测记录，剩余 '+j.remainingNodes+' 个节点'):('失败: '+j.error));if(j.ok) location.reload();}
  async function resetSub(id,name){if(!confirm('确认重置 '+(name||('订阅 #'+id))+' 吗？')) return;const r=await fetch('/api/subscriptions/'+id+'/reset',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?('新链接: ${escapeJs(PUBLIC_BASE_URL)}/sub/'+j.item.token):('失败: '+j.error));if(j.ok) location.reload();}
  async function disableSub(id,name){if(!confirm('确认关闭 '+(name||('订阅 #'+id))+' 吗？')) return;const r=await fetch('/api/subscriptions/'+id+'/disable',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'已关闭':'失败: '+j.error);if(j.ok) location.reload();}
  async function enableSub(id,name){if(!confirm('确认恢复 '+(name||('订阅 #'+id))+' 吗？')) return;const r=await fetch('/api/subscriptions/'+id+'/enable',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'已恢复':'失败: '+j.error);if(j.ok) location.reload();}
  async function changeSubToken(id,currentToken){const token=prompt('输入新的 token', currentToken||'');if(token===null) return;const r=await fetch('/api/subscriptions/'+id+'/update-token',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({token})});const j=await readJsonSafe(r);alert(j.ok?'已更新':'失败: '+j.error);if(j.ok) location.reload();}
  async function deleteSub(id,name){if(!confirm('确认删除 '+(name||('订阅 #'+id))+' 吗？')) return;const r=await fetch('/api/subscriptions/'+id,{method:'DELETE',credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'已删除':'失败: '+j.error);if(j.ok) location.reload();}
  async function clearSubDevices(id,name){if(!confirm('确认清空 '+(name||('订阅 #'+id))+' 的设备指纹记录吗？清空后会重新开始统计 5 个设备指纹。')) return;const r=await fetch('/api/subscriptions/'+id+'/clear-devices',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'设备指纹记录已清空':'失败: '+j.error);if(j.ok) location.reload();}
  async function extendUser(id,days){const r=await fetch('/api/users/'+id+'/extend',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({days})});const j=await readJsonSafe(r);alert(j.ok?('已延长 '+days+' 天'):('失败: '+j.error));if(j.ok) location.reload();}
  async function toggleUser(id,status){const r=await fetch('/api/users/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({status})});const j=await readJsonSafe(r);alert(j.ok?'状态已更新':'失败: '+j.error);if(j.ok) location.reload();}
  async function resetUserPassword(id,username){const newPassword=prompt('给用户 '+username+' 设置新密码');if(newPassword===null) return;const r=await fetch('/api/users/'+id+'/password',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({newPassword})});const j=await readJsonSafe(r);alert(j.ok?'密码已重置':'失败: '+j.error);if(j.ok) location.reload();}
  async function forceResetUserSub(id,username){if(!confirm('确认强制更新 '+username+' 的订阅地址吗？旧地址会立刻失效。')) return;const r=await fetch('/api/users/'+id+'/reset-subscription',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin'});const j=await readJsonSafe(r);if(!j.ok){alert('失败: '+j.error);return;}const url=j.url||('${escapeJs(PUBLIC_BASE_URL)}/sub/'+j.item.token);prompt('新的完整订阅地址（已可复制）', url);location.reload();}
  async function copyUserSub(token,username){if(!token){alert('这个用户还没有订阅地址');return;}const url='${escapeJs(PUBLIC_BASE_URL)}/sub/'+token;try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(url);alert(username+' 的订阅地址已复制');return;}}catch(_){ }prompt(username+' 的当前订阅地址（可复制）', url);}
  async function deleteUserAccount(id,username){if(!confirm('确认删除用户 '+username+' 吗？\\n这会同时删除该用户会话和独立订阅，且不可恢复。')) return;const r=await fetch('/api/users/'+id,{method:'DELETE',credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?('已删除用户：'+username):('失败: '+j.error));if(j.ok) location.reload();}
  async function createInvite(e){e.preventDefault();const fd=new FormData(e.target);const payload=Object.fromEntries(fd.entries());const r=await fetch('/api/invite-codes',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload)});const j=await readJsonSafe(r);alert(j.ok?('邀请码：'+j.item.code):('失败: '+j.error));if(j.ok) location.reload();}
  async function toggleInvite(id,enabled){const r=await fetch('/api/invite-codes/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({enabled})});const j=await readJsonSafe(r);alert(j.ok?'邀请码状态已更新':'失败: '+j.error);if(j.ok) location.reload();}
  async function removeInvite(id,code){if(!confirm('确认删除邀请码 '+code+' 吗？删除后不可恢复。')) return;const r=await fetch('/api/invite-codes/'+id,{method:'DELETE',credentials:'same-origin'});const j=await readJsonSafe(r);alert(j.ok?'邀请码已删除':'失败: '+j.error);if(j.ok) location.reload();}
</script>`; }
function escapeHtml(input) { return String(input).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function escapeJs(input) { return String(input).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' '); }

app.listen(PORT, () => {
  console.log(`VIP8 Node Hub listening on http://0.0.0.0:${PORT}`);
  syncAllUserSubscriptions();
  setInterval(() => {
    try { syncAllUserSubscriptions(); } catch (err) { console.error('syncAllUserSubscriptions failed:', err?.message || err); }
  }, Number(process.env.SUBSCRIPTION_SYNC_INTERVAL_MS || 60 * 1000));
  startAutoChecker({
    intervalMs: Number(process.env.AUTO_CHECK_INTERVAL_MS || 30 * 60 * 1000),
    timeoutMs: Number(process.env.CHECK_TIMEOUT_MS || 3000),
    batchSize: Number(process.env.AUTO_CHECK_BATCH_SIZE || 80),
  });
});
