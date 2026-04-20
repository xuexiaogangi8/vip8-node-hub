import db from '../src/db.js';
import { createSubscription } from '../src/subscriptions.js';

const exists = db.prepare(`SELECT * FROM subscriptions WHERE token = ?`).get('vip8-demo-token');
if (!exists) {
  const row = createSubscription({ name: 'Default Subscription', token: 'vip8-demo-token', online_only: 1 });
  console.log('created', row);
} else {
  console.log('exists', exists);
}
