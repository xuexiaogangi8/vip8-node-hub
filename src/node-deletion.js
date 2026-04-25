import db from './db.js';

export function deleteNodesByIds(nodeIds = []) {
  const ids = [...new Set((nodeIds || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return { deletedNodes: 0, deletedChecks: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const deletedChecks = db.prepare(`SELECT COUNT(*) AS count FROM checks WHERE node_id IN (${placeholders})`).get(...ids).count || 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM checks WHERE node_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...ids);
  });
  tx();
  return { deletedNodes: ids.length, deletedChecks };
}

export function deleteNodeById(nodeId) {
  return deleteNodesByIds([nodeId]);
}
