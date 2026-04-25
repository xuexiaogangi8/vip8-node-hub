import db from './db.js';
import { deleteNodesByIds } from './node-deletion.js';

function normalizeName(name) {
  const value = String(name || '').trim();
  return value || null;
}

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) throw new Error('订阅链接不能为空');
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('订阅链接必须是 http 或 https');
    return parsed.toString();
  } catch {
    throw new Error('订阅链接格式不正确');
  }
}

export function inferSourceNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.').filter(Boolean);
    const skip = new Set(['www', 'm', 'api', 'sub', 'subscribe', 'subscription', 'cdn']);
    const picked = parts.find((part) => !skip.has(part) && !/^\d+$/.test(part)) || parts[0] || host;
    return picked.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  } catch {
    return '未命名机场';
  }
}

function getSourceByWhere(where, value) {
  return db.prepare(`SELECT * FROM subscription_sources WHERE ${where} = ? LIMIT 1`).get(value);
}

export function getSourceById(id) {
  return getSourceByWhere('id', Number(id));
}

export function getSourceByUrl(url) {
  try {
    return getSourceByWhere('url', normalizeUrl(url));
  } catch {
    return null;
  }
}

export function listSourceSubscriptions() {
  return db.prepare(`
    SELECT ss.*, (
      SELECT COUNT(*) FROM nodes n WHERE n.source_subscription_id = ss.id
    ) AS node_count
    FROM subscription_sources ss
    ORDER BY ss.id DESC
  `).all();
}

export function createSourceSubscription({ name = null, url, status = 'active' }) {
  const finalUrl = normalizeUrl(url);
  const finalName = normalizeName(name) || inferSourceNameFromUrl(finalUrl);
  const host = new URL(finalUrl).hostname.toLowerCase();
  const finalStatus = status === 'disabled' ? 'disabled' : 'active';
  const result = db.prepare(`
    INSERT INTO subscription_sources (name, url, site_host, status)
    VALUES (?, ?, ?, ?)
  `).run(finalName, finalUrl, host, finalStatus);
  return getSourceById(result.lastInsertRowid);
}

export function ensureSourceSubscription({ name = null, url, status = 'active' }) {
  const finalUrl = normalizeUrl(url);
  const existing = getSourceByUrl(finalUrl);
  if (existing) {
    if (name && String(name).trim() && existing.name !== String(name).trim()) {
      db.prepare(`UPDATE subscription_sources SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(String(name).trim(), existing.id);
      return getSourceById(existing.id);
    }
    return existing;
  }
  return createSourceSubscription({ name, url: finalUrl, status });
}

export function updateSourceSubscription(id, { name, url, status }) {
  const existing = getSourceById(id);
  if (!existing) return null;
  const finalUrl = url !== undefined ? normalizeUrl(url) : existing.url;
  const finalName = name !== undefined ? (normalizeName(name) || inferSourceNameFromUrl(finalUrl)) : existing.name;
  const host = new URL(finalUrl).hostname.toLowerCase();
  const finalStatus = status === 'disabled' ? 'disabled' : status === 'invalid' ? 'invalid' : 'active';
  const conflict = db.prepare(`SELECT 1 FROM subscription_sources WHERE url = ? AND id != ?`).get(finalUrl, id);
  if (conflict) throw new Error('这个订阅链接已经存在');
  db.prepare(`
    UPDATE subscription_sources
    SET name = ?, url = ?, site_host = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalName, finalUrl, host, finalStatus, id);
  return getSourceById(id);
}

export function setSourceSubscriptionStatus(id, status) {
  const existing = getSourceById(id);
  if (!existing) return null;
  const finalStatus = status === 'disabled' ? 'disabled' : status === 'invalid' ? 'invalid' : 'active';
  db.prepare(`UPDATE subscription_sources SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(finalStatus, id);
  return getSourceById(id);
}

export function touchSourceFetchResult(id, { status = 'active', lastError = null, nodeCount = null } = {}) {
  const existing = getSourceById(id);
  if (!existing) return null;
  const finalStatus = status === 'disabled' ? 'disabled' : status === 'invalid' ? 'invalid' : 'active';
  db.prepare(`
    UPDATE subscription_sources
    SET status = ?, last_fetch_at = CURRENT_TIMESTAMP, last_error = ?, last_node_count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalStatus, lastError || null, Number.isFinite(Number(nodeCount)) ? Number(nodeCount) : null, id);
  return getSourceById(id);
}

export function deleteSourceSubscription(id, { deleteNodes = true } = {}) {
  const existing = getSourceById(id);
  if (!existing) return null;
  const tx = db.transaction(() => {
    if (deleteNodes) {
      const nodeIds = db.prepare(`SELECT id FROM nodes WHERE source_subscription_id = ?`).all(id).map((x) => x.id);
      if (nodeIds.length) deleteNodesByIds(nodeIds);
    } else {
      db.prepare(`UPDATE nodes SET source_subscription_id = NULL WHERE source_subscription_id = ?`).run(id);
    }
    db.prepare(`DELETE FROM subscription_sources WHERE id = ?`).run(id);
  });
  tx();
  return existing;
}
