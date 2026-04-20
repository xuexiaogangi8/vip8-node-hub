import db from '../src/db.js';

try {
  db.exec(`ALTER TABLE nodes ADD COLUMN dedupe_key TEXT`);
} catch (_) {}

const rows = db.prepare(`SELECT id, protocol, host, port, created_at FROM nodes ORDER BY id ASC`).all();
const seen = new Map();

for (const row of rows) {
  const key = `${String(row.protocol).toLowerCase()}:${String(row.host).toLowerCase()}:${row.port}`;
  if (seen.has(key)) {
    db.prepare(`DELETE FROM checks WHERE node_id = ?`).run(row.id);
    db.prepare(`DELETE FROM nodes WHERE id = ?`).run(row.id);
  } else {
    seen.set(key, row.id);
    db.prepare(`UPDATE nodes SET dedupe_key = ? WHERE id = ?`).run(key, row.id);
  }
}

try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_dedupe_key ON nodes(dedupe_key)`);
} catch (e) {
  console.error(e.message);
}

console.log(JSON.stringify({ ok: true, total: seen.size }, null, 2));
