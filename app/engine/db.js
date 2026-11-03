// Store: real Postgres when DATABASE_URL is set (the client's server), otherwise
// PGlite (Postgres compiled to WASM) in a local folder for dev and single-PC installs.
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','staff','admin')),
  pass_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar JSONB NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'ask_risky' CHECK (autonomy IN ('ask_all','ask_risky','just_do_it')),
  allowed_roles JSONB NOT NULL DEFAULT '["owner","manager","staff","admin"]',
  status_text TEXT NOT NULL DEFAULT 'Idle',
  sort INT NOT NULL DEFAULT 0,
  monthly_cap_usd NUMERIC NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  api_content JSONB,
  text TEXT NOT NULL DEFAULT '',
  cards JSONB NOT NULL DEFAULT '[]',
  hidden BOOLEAN NOT NULL DEFAULT false,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_bot ON messages(bot_id, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','approval_needed','awaiting_feedback','review','scheduled','done','failed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','manual','schedule','trigger')),
  created_by_type TEXT NOT NULL DEFAULT 'user' CHECK (created_by_type IN ('user','bot')),
  created_by TEXT,
  result TEXT NOT NULL DEFAULT '',
  approval JSONB,
  feedback JSONB,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'bot',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feed (
  id TEXT PRIMARY KEY,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'info' CHECK (importance IN ('info','important','critical')),
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feed_reads (
  feed_id TEXT NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, user_id)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload','bot')),
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document',
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown','html')),
  content TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'bot',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cache_read_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_actions (
  id TEXT PRIMARY KEY,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  toolkit TEXT NOT NULL,
  slug TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_actions_month ON app_actions(created_at);
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('schedule','app')),
  schedule JSONB,
  app_event JSONB,
  instructions TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  max_per_hour INT NOT NULL DEFAULT 20,
  last_slot TEXT,
  last_fired_at TIMESTAMPTZ,
  fire_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trigger_events (
  id TEXT PRIMARY KEY,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_events_recent ON trigger_events(trigger_id, created_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
-- Added after v0.1: task descriptions, the "review" status (bots suggest done, people
-- mark it), task notes and editable task templates. Safe to re-run on existing databases.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE app_actions ADD COLUMN IF NOT EXISTS log_id TEXT; -- Composio's log ID, for tracing a call in its dashboard
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('queued','in_progress','approval_needed','awaiting_feedback','review','scheduled','done','failed','cancelled'));
CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(task_id, created_at);
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  file_ids JSONB NOT NULL DEFAULT '[]',
  sort INT NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function openDb({ dataDir, databaseUrl } = {}) {
  let query;
  let close;
  if (databaseUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    query = (sql, params) => pool.query(sql, params);
    close = () => pool.end();
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = dataDir === ':memory:' ? undefined : path.join(dataDir, 'db');
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const pg = new PGlite(dir);
    await pg.waitReady;
    query = (sql, params) => pg.query(sql, params);
    close = () => pg.close();
  }
  // PGlite runs one statement per query() call with params, so split the schema.
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await query(stmt);
  }

  const db = {
    async all(sql, params = []) { return (await query(sql, params)).rows; },
    async one(sql, params = []) { return (await query(sql, params)).rows[0] || null; },
    async run(sql, params = []) { await query(sql, params); },
    close,
  };
  return db;
}

module.exports = { openDb };
