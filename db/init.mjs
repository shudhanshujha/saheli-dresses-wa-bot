import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'bot.db'));
db.pragma('journal_mode = WAL'); // better concurrent read/write behavior

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    wa_id TEXT UNIQUE NOT NULL,
    name TEXT,
    tags TEXT DEFAULT '[]',       -- store JSON array as text
    label TEXT,
    notes TEXT,
    last_message_at TEXT,
    last_reply_at TEXT,
    status TEXT DEFAULT 'active', -- active | pending | unresponsive | opted_out
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS broadcast_campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    template_id TEXT,
    target_type TEXT,
    total_targets INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,      -- relative path under data/media/
    mime_type TEXT,
    file_name TEXT,
    size_bytes INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_history (
    id TEXT PRIMARY KEY,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    wa_id TEXT NOT NULL,
    campaign_id TEXT REFERENCES broadcast_campaigns(id) ON DELETE SET NULL,
    source TEXT,                  -- campaign | scheduled | manual | flow | auto_reply
    direction TEXT DEFAULT 'outbound',
    body TEXT,
    media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'sent',   -- sent | delivered | read | failed
    wa_message_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
    reason TEXT,                  -- awaiting_reply | flow_incomplete | campaign_no_response
    message_id TEXT REFERENCES message_history(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_msg_wa_id_created ON message_history (wa_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_created ON message_history (created_at);
  CREATE INDEX IF NOT EXISTS idx_waitlist_open ON waitlist (contact_id) WHERE resolved_at IS NULL;
`);

export default db;
