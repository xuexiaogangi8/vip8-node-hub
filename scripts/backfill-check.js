import { checkAllNodes } from '../src/scheduler.js';

const results = await checkAllNodes(Number(process.env.CHECK_TIMEOUT_MS || 3000));
console.log(JSON.stringify({ ok: true, total: results.length, results }, null, 2));
