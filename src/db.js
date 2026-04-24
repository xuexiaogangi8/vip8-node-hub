import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  source_subscription_id INTEGER,
  name TEXT,
  protocol TEXT NOT NULL,
  raw TEXT NOT NULL UNIQUE,
  dedupe_key TEXT UNIQUE,
  host TEXT,
  port INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_subscription_id) REFERENCES subscription_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error TEXT,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  token TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  online_only INTEGER NOT NULL DEFAULT 1,
  protocol_filter TEXT,
  device_limit INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscription_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  url TEXT NOT NULL UNIQUE,
  site_host TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_fetch_at TEXT,
  last_error TEXT,
  last_node_count INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscription_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  device_key TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hits INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  UNIQUE(subscription_id, device_key)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  invite_code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_admin INTEGER NOT NULL DEFAULT 0,
  membership_expires_at TEXT,
  subscription_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS member_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  cf_connecting_ip TEXT,
  x_forwarded_for TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  note TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((x) => x.name);
if (!userCols.includes('email')) db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all().map((x) => x.name);
if (!subCols.includes('device_limit')) db.exec(`ALTER TABLE subscriptions ADD COLUMN device_limit INTEGER NOT NULL DEFAULT 5`);
const nodeCols = db.prepare(`PRAGMA table_info(nodes)`).all().map((x) => x.name);
if (!nodeCols.includes('source_subscription_id')) db.exec(`ALTER TABLE nodes ADD COLUMN source_subscription_id INTEGER`);
const sourceCols = db.prepare(`PRAGMA table_info(subscription_sources)`).all().map((x) => x.name);
if (!sourceCols.includes('updated_at')) db.exec(`ALTER TABLE subscription_sources ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
if (!sourceCols.includes('site_host')) db.exec(`ALTER TABLE subscription_sources ADD COLUMN site_host TEXT`);
if (!sourceCols.includes('status')) db.exec(`ALTER TABLE subscription_sources ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
if (!sourceCols.includes('last_fetch_at')) db.exec(`ALTER TABLE subscription_sources ADD COLUMN last_fetch_at TEXT`);
if (!sourceCols.includes('last_error')) db.exec(`ALTER TABLE subscription_sources ADD COLUMN last_error TEXT`);
if (!sourceCols.includes('last_node_count')) db.exec(`ALTER TABLE subscription_sources ADD COLUMN last_node_count INTEGER`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_member_sessions_token ON member_sessions(token);
  CREATE INDEX IF NOT EXISTS idx_subscription_devices_subid ON subscription_devices(subscription_id, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_audit_created_at ON login_audit(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_verification_codes(email, purpose, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_source_subscription_id ON nodes(source_subscription_id);
  CREATE INDEX IF NOT EXISTS idx_subscription_sources_status ON subscription_sources(status, id DESC);
`);

export default db;
