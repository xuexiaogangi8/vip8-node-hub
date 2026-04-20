import crypto from 'crypto';
import db from './db.js';

export function generateToken(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

export function listSubscriptions() {
  return db.prepare(`
    SELECT s.*, (
      SELECT COUNT(*) FROM subscription_devices sd WHERE sd.subscription_id = s.id
    ) AS device_count
    FROM subscriptions s
    ORDER BY s.id DESC
  `).all();
}

export function createSubscription({ name, token, online_only = 1, protocol_filter = null, device_limit = 5 }) {
  const finalToken = token?.trim() || generateToken(16);
  const stmt = db.prepare(`
    INSERT INTO subscriptions (name, token, enabled, online_only, protocol_filter, device_limit)
    VALUES (?, ?, 1, ?, ?, ?)
  `);
  const result = stmt.run(name || null, finalToken, online_only ? 1 : 0, protocol_filter || null, Math.max(1, Number(device_limit || 5)));
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(result.lastInsertRowid);
}

export function getSubscriptionByToken(token) {
  return db.prepare(`
    SELECT s.*
    FROM subscriptions s
    JOIN users u ON u.subscription_id = s.id
    WHERE s.token = ?
      AND s.enabled = 1
      AND u.status = 'active'
      AND u.membership_expires_at IS NOT NULL
      AND datetime(u.membership_expires_at) > datetime('now')
    LIMIT 1
  `).get(token);
}

export function resetSubscriptionToken(id) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) return null;

  let token = '';
  do {
    token = generateToken(16);
  } while (db.prepare(`SELECT 1 FROM subscriptions WHERE token = ? AND id != ?`).get(token, id));

  db.prepare(`UPDATE subscriptions SET token = ? WHERE id = ?`).run(token, id);
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
}

export function disableSubscription(id) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) return null;
  db.prepare(`UPDATE subscriptions SET enabled = 0 WHERE id = ?`).run(id);
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
}

export function enableSubscription(id) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) return null;
  db.prepare(`UPDATE subscriptions SET enabled = 1 WHERE id = ?`).run(id);
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
}

export function updateSubscriptionToken(id, token) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) return null;
  const finalToken = String(token || '').trim();
  if (!finalToken) throw new Error('token 不能为空');
  const conflict = db.prepare(`SELECT 1 FROM subscriptions WHERE token = ? AND id != ?`).get(finalToken, id);
  if (conflict) throw new Error('token 已存在');
  db.prepare(`UPDATE subscriptions SET token = ? WHERE id = ?`).run(finalToken, id);
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
}

export function deleteSubscription(id) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) return null;
  db.prepare(`DELETE FROM subscriptions WHERE id = ?`).run(id);
  return existing;
}

export function clearSubscriptionDevices(id) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) return null;
  db.prepare(`DELETE FROM subscription_devices WHERE subscription_id = ?`).run(id);
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
}
