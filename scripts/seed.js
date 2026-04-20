import db from '../src/db.js';

const samples = [
  {
    source_type: 'seed',
    source_ref: 'demo',
    name: 'Cloudflare DNS Test',
    protocol: 'trojan',
    raw: 'trojan://demo-pass@1.1.1.1:443#Cloudflare%20DNS%20Test',
    host: '1.1.1.1',
    port: 443,
  },
  {
    source_type: 'seed',
    source_ref: 'demo',
    name: 'Google HTTPS Test',
    protocol: 'vless',
    raw: 'vless://demo-uuid@8.8.8.8:443?security=tls#Google%20HTTPS%20Test',
    host: '8.8.8.8',
    port: 443,
    dedupe_key: 'vless:8.8.8.8:443',
  }
];

const stmt = db.prepare(`INSERT OR IGNORE INTO nodes (source_type, source_ref, name, protocol, raw, host, port) VALUES (@source_type, @source_ref, @name, @protocol, @raw, @host, @port)`);
for (const item of samples) stmt.run(item);
console.log('Seed done');

