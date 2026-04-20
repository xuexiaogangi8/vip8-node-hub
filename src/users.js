import crypto from 'crypto';
import db from './db.js';
import { createSubscription, resetSubscriptionToken } from './subscriptions.js';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function subscriptionShouldBeEnabled(user) {
  if (!user?.subscription_id) return false;
  if (user.status !== 'active') return false;
  if (!user.membership_expires_at) return false;
  return new Date(user.membership_expires_at).getTime() > Date.now();
}

function syncSubscriptionEnabledForUser(user) {
  if (!user?.subscription_id) return user;
  const enabled = subscriptionShouldBeEnabled(user) ? 1 : 0;
  db.prepare(`UPDATE subscriptions SET enabled = ? WHERE id = ?`).run(enabled, user.subscription_id);
  return user;
}

function deriveUsernameFromEmail(email) {
  const base = normalizeEmail(email).split('@')[0].replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'user';
  let name = base;
  let i = 0;
  while (getUserByUsername(name)) {
    i += 1;
    name = `${base.slice(0, Math.max(1, 24 - String(i).length))}${i}`;
  }
  return name;
}

export function listUsers() {
  syncAllUserSubscriptions();
  return db.prepare(`
    SELECT u.*, s.token AS subscription_token, s.enabled AS subscription_enabled
    FROM users u
    LEFT JOIN subscriptions s ON s.id = u.subscription_id
    ORDER BY u.id DESC
  `).all();
}

export function getUserById(id) {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  return syncSubscriptionEnabledForUser(user);
}

export function getUserByUsername(username) {
  return db.prepare(`SELECT * FROM users WHERE lower(username) = lower(?)`).get(String(username || '').trim());
}

export function getUserByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`).get(normalizeEmail(email));
}

export function getUserByLogin(login) {
  const key = String(login || '').trim();
  return key.includes('@') ? getUserByEmail(key) : getUserByUsername(key);
}

export function getUserBySessionToken(token) {
  const user = db.prepare(`
    SELECT u.*
    FROM member_sessions ms
    JOIN users u ON u.id = ms.user_id
    WHERE ms.token = ? AND ms.expires_at > datetime('now')
    ORDER BY ms.id DESC LIMIT 1
  `).get(token);
  return syncSubscriptionEnabledForUser(user);
}

export function getInviteCode(code) {
  return db.prepare(`SELECT * FROM invite_codes WHERE code = ?`).get(String(code || '').trim());
}

export function listInviteCodes() {
  return db.prepare(`SELECT * FROM invite_codes ORDER BY id DESC`).all();
}

export function createInviteCode({ note = null, maxUses = 1, code = null }) {
  const finalCode = String(code || crypto.randomBytes(4).toString('hex')).trim();
  const uses = Math.max(1, Number(maxUses || 1));
  db.prepare(`INSERT INTO invite_codes (code, note, max_uses, enabled) VALUES (?, ?, ?, 1)`).run(finalCode, note || null, uses);
  return getInviteCode(finalCode);
}

export function setInviteCodeStatus(id, enabled) {
  db.prepare(`UPDATE invite_codes SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  return db.prepare(`SELECT * FROM invite_codes WHERE id = ?`).get(id);
}

export function deleteInviteCode(id) {
  const item = db.prepare(`SELECT * FROM invite_codes WHERE id = ?`).get(id);
  if (!item) return null;
  db.prepare(`DELETE FROM invite_codes WHERE id = ?`).run(id);
  return item;
}

function useInviteCode(code) {
  const invite = getInviteCode(code);
  if (!invite) throw new Error('邀请码不存在');
  if (!invite.enabled) throw new Error('邀请码已停用');
  if (invite.used_count >= invite.max_uses) throw new Error('邀请码已用完');
  db.prepare(`UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?`).run(invite.id);
  return invite;
}

export function createUser({ username = null, email = null, password, inviteCode = null, isAdmin = 0 }) {
  const finalEmail = normalizeEmail(email);
  const finalUsername = String(username || '').trim() || (finalEmail ? deriveUsernameFromEmail(finalEmail) : '');
  const finalPassword = String(password || '');
  const finalInviteCode = String(inviteCode || '').trim();
  if (finalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finalEmail)) throw new Error('邮箱格式不正确');
  if (!finalUsername || !/^[a-zA-Z0-9_]{3,32}$/.test(finalUsername)) throw new Error('用户名只能包含字母、数字、下划线，长度 3-32');
  if (finalPassword.length < 6) throw new Error('密码至少 6 位');
  if (getUserByUsername(finalUsername)) throw new Error('用户名已存在');
  if (finalEmail && getUserByEmail(finalEmail)) throw new Error('邮箱已被注册');
  if (!isAdmin) {
    if (!finalInviteCode) throw new Error('需要邀请码才能注册');
    if (!finalEmail) throw new Error('需要邮箱才能注册');
    useInviteCode(finalInviteCode);
  }

  const subscription = createSubscription({
    name: `会员 ${finalUsername}`,
    token: null,
    online_only: 1,
    protocol_filter: null,
  });

  const result = db.prepare(`
    INSERT INTO users (username, email, password_hash, invite_code, is_admin, subscription_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(finalUsername, finalEmail || null, hashPassword(finalPassword), finalInviteCode || null, isAdmin ? 1 : 0, subscription.id);

  return getUserById(result.lastInsertRowid);
}

export function authenticateUser(login, password) {
  const user = getUserByLogin(login);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

export function createMemberSession(userId, days = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO member_sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', ?))`).run(userId, token, `+${days} days`);
  return token;
}

export function revokeMemberSession(token) {
  db.prepare(`DELETE FROM member_sessions WHERE token = ?`).run(token);
}

export function addMembershipDays(userId, days) {
  const n = Number(days || 0);
  if (!Number.isFinite(n) || n === 0) throw new Error('天数不合法');
  db.prepare(`
    UPDATE users
    SET membership_expires_at = CASE
      WHEN membership_expires_at IS NULL OR membership_expires_at < datetime('now') THEN datetime('now', ?)
      ELSE datetime(membership_expires_at, ?)
    END
    WHERE id = ?
  `).run(`+${n} days`, `+${n} days`, userId);
  return getUserById(userId);
}

export function setUserStatus(userId, status) {
  const finalStatus = status === 'disabled' ? 'disabled' : 'active';
  db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(finalStatus, userId);
  return getUserById(userId);
}

export function syncAllUserSubscriptions() {
  db.prepare(`
    UPDATE subscriptions
    SET enabled = CASE
      WHEN EXISTS (
        SELECT 1
        FROM users u
        WHERE u.subscription_id = subscriptions.id
          AND u.status = 'active'
          AND u.membership_expires_at IS NOT NULL
          AND datetime(u.membership_expires_at) > datetime('now')
      ) THEN 1
      ELSE 0
    END
  `).run();
}

export function logLoginAttempt({ username = null, ok = 0, ip = null, ua = null, cfIp = null, xff = null }) {
  db.prepare(`
    INSERT INTO login_audit (username, ok, ip, user_agent, cf_connecting_ip, x_forwarded_for)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, ok ? 1 : 0, ip, ua, cfIp, xff);
}

export function saveEmailVerificationCode({ email, code, purpose = 'register', ip = null }) {
  const finalEmail = normalizeEmail(email);
  db.prepare(`DELETE FROM email_verification_codes WHERE email = ? AND purpose = ?`).run(finalEmail, purpose);
  db.prepare(`
    INSERT INTO email_verification_codes (email, code, purpose, ip, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))
  `).run(finalEmail, String(code), String(purpose || 'register'), ip || null);
}

export function recentEmailSendCount(email, purpose = 'register', minutes = 10) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM email_verification_codes
    WHERE email = ? AND purpose = ? AND created_at > datetime('now', ?)
  `).get(normalizeEmail(email), purpose, `-${Number(minutes || 10)} minutes`)?.count || 0;
}

export function verifyEmailCode({ email, code, purpose = 'register' }) {
  const row = db.prepare(`
    SELECT * FROM email_verification_codes
    WHERE email = ? AND purpose = ?
    ORDER BY id DESC LIMIT 1
  `).get(normalizeEmail(email), String(purpose || 'register'));
  if (!row) throw new Error('请先获取验证码');
  if (row.used_at) throw new Error('验证码已使用');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error('验证码已过期');
  if (Number(row.attempts || 0) >= 5) throw new Error('验证码错误次数过多，请重新获取');
  if (String(code || '').trim() !== String(row.code || '').trim()) {
    db.prepare(`UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
    throw new Error('验证码错误');
  }
  db.prepare(`UPDATE email_verification_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  return true;
}

export function resetUserSubscriptionToken(userId) {
  const user = getUserById(userId);
  if (!user?.subscription_id) throw new Error('用户还没有订阅');
  return resetSubscriptionToken(user.subscription_id);
}

export function changeOwnPassword(userId, oldPassword, newPassword) {
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  if (!verifyPassword(String(oldPassword || ''), user.password_hash)) throw new Error('旧密码不正确');
  const finalPassword = String(newPassword || '');
  if (finalPassword.length < 6) throw new Error('新密码至少 6 位');
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(finalPassword), userId);
  return getUserById(userId);
}

export function adminResetUserPassword(userId, newPassword) {
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  const finalPassword = String(newPassword || '');
  if (finalPassword.length < 6) throw new Error('新密码至少 6 位');
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(finalPassword), userId);
  return getUserById(userId);
}

export function deleteUser(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  if (Number(user.is_admin || 0) === 1) throw new Error('不能删除管理员账号');
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM member_sessions WHERE user_id = ?`).run(user.id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    if (user.subscription_id) db.prepare(`DELETE FROM subscriptions WHERE id = ?`).run(user.subscription_id);
  });
  tx();
  return user;
}

export function membershipActive(user) {
  if (!user) return false;
  if (user.status !== 'active') return false;
  if (!user.membership_expires_at) return false;
  return new Date(user.membership_expires_at).getTime() > Date.now();
}
