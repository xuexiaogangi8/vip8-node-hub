import db from './db.js';
import { probeNode } from './checker.js';
import { deleteNodeById } from './node-deletion.js';

const KEEP_CHECKS_PER_NODE = Number(process.env.KEEP_CHECKS_PER_NODE || 30);
const DISABLE_FAIL_STREAK = Number(process.env.DISABLE_FAIL_STREAK || 5);
const DELETE_FAIL_STREAK = Number(process.env.DELETE_FAIL_STREAK || 10);
const DEFAULT_CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 5000);

function getFailStreak(nodeId) {
  const rows = db.prepare(`SELECT status FROM checks WHERE node_id = ? ORDER BY id DESC LIMIT 20`).all(nodeId);
  let streak = 0;
  for (const row of rows) {
    if (row.status !== 'fail') break;
    streak += 1;
  }
  return streak;
}

function pruneOldChecks(nodeId) {
  db.prepare(`
    DELETE FROM checks
    WHERE node_id = ?
      AND id NOT IN (
        SELECT id FROM checks WHERE node_id = ? ORDER BY id DESC LIMIT ?
      )
  `).run(nodeId, nodeId, KEEP_CHECKS_PER_NODE);
}

function applyFailurePolicy(nodeId) {
  const node = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(nodeId);
  if (!node) return { action: null, failStreak: 0 };

  const failStreak = getFailStreak(nodeId);

  if (failStreak >= DELETE_FAIL_STREAK) {
    deleteNodeById(nodeId);
    return { action: 'deleted', failStreak };
  }

  if (failStreak >= DISABLE_FAIL_STREAK && node.enabled !== 0) {
    db.prepare(`UPDATE nodes SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nodeId);
    return { action: 'disabled', failStreak };
  }

  return { action: null, failStreak };
}

async function runCheck(node, timeoutMs) {
  const result = await probeNode(node, timeoutMs);
  db.prepare(`INSERT INTO checks (node_id, status, latency_ms, error) VALUES (?, ?, ?, ?)`).run(
    node.id,
    result.ok ? 'ok' : 'fail',
    result.latency || null,
    result.error || result.warning || null,
  );
  pruneOldChecks(node.id);
  const policy = applyFailurePolicy(node.id);
  return { node, result, policy };
}

export async function checkNodeById(nodeId, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {
  const node = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(nodeId);
  if (!node) return null;
  return runCheck(node, timeoutMs);
}

export async function checkAllNodes(timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, limit = null, cursorId = null) {
  const max = Number(limit || 0) > 0 ? Number(limit) : null;
  const cursor = Number(cursorId || 0) || null;
  let sql = `SELECT * FROM nodes WHERE enabled = 1`;
  const params = [];
  if (cursor) {
    sql += ` AND id < ?`;
    params.push(cursor);
  }
  sql += ` ORDER BY id DESC`;
  if (max) {
    sql += ` LIMIT ?`;
    params.push(max);
  }
  const nodes = db.prepare(sql).all(...params);
  const results = [];
  for (const node of nodes) results.push(await runCheck(node, timeoutMs));
  return results.map(({ node, result, policy }) => ({ id: node.id, name: node.name, protocol: node.protocol, ...result, policy }));
}

export function startAutoChecker({ intervalMs = 10 * 60 * 1000, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, batchSize = 100 } = {}) {
  let running = false;
  let lastCursorId = null;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const results = await checkAllNodes(timeoutMs, batchSize, lastCursorId);
      if (!results.length) {
        lastCursorId = null;
        running = false;
        return;
      }
      lastCursorId = Math.min(...results.map((r) => r.id));
      const disabled = results.filter((r) => r.policy?.action === 'disabled').length;
      const deleted = results.filter((r) => r.policy?.action === 'deleted').length;
      const udp = results.filter((r) => r.probe === 'udp').length;
      console.log(`[auto-check] checked ${results.length} nodes, udp ${udp}, disabled ${disabled}, deleted ${deleted}, next_cursor ${lastCursorId}`);
    } catch (error) {
      console.error('[auto-check] failed:', error.message);
    } finally {
      running = false;
    }
  };

  setTimeout(run, 5000);
  const timer = setInterval(run, intervalMs);
  return timer;
}
