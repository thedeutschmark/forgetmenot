/**
 * SQLite schema for ForgetMeNot.
 *
 * Three-tier memory model:
 *   Tier 1: events (raw, TTL-pruned)
 *   Tier 2: episodes (mid-term summaries)
 *   Tier 3: semantic_notes (durable facts)
 *
 * Plus: viewers, action_logs, bot_messages, channel_state
 */

export const SCHEMA_VERSION = 2;

export const MIGRATIONS: string[] = [
  /* v1 — initial schema */
  `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_state (
    broadcaster_twitch_id TEXT PRIMARY KEY,
    stream_title TEXT,
    stream_category TEXT,
    is_live INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT
  );

  CREATE TABLE IF NOT EXISTS viewers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_user_id TEXT UNIQUE,
    login TEXT NOT NULL,
    display_name TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    trust_level TEXT NOT NULL DEFAULT 'unknown',
    opt_in_fun_moderation INTEGER NOT NULL DEFAULT 0,
    is_regular INTEGER NOT NULL DEFAULT 0,
    is_mod INTEGER NOT NULL DEFAULT 0,
    is_vip INTEGER NOT NULL DEFAULT 0,
    notes_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_viewers_login ON viewers(login);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    twitch_user_id TEXT,
    message_text TEXT,
    source TEXT NOT NULL DEFAULT 'chat',
    importance_score REAL NOT NULL DEFAULT 0.0,
    ttl_expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_user ON events(twitch_user_id);

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    topic TEXT,
    participants_json TEXT,
    summary TEXT,
    importance_score REAL NOT NULL DEFAULT 0.0,
    source_event_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status, started_at DESC);

  CREATE TABLE IF NOT EXISTS semantic_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT,
    category TEXT,
    fact TEXT NOT NULL,
    supporting_evidence TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'active',
    first_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by INTEGER REFERENCES semantic_notes(id)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_scope ON semantic_notes(scope, subject_id, status);

  CREATE TABLE IF NOT EXISTS action_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    action_type TEXT NOT NULL,
    target_twitch_user_id TEXT,
    target_login TEXT,
    reason TEXT,
    policy_result TEXT NOT NULL,
    proposed_by TEXT NOT NULL DEFAULT 'llm',
    executed INTEGER NOT NULL DEFAULT 0,
    execution_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_actions_time ON action_logs(occurred_at DESC);

  CREATE TABLE IF NOT EXISTS bot_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    reply_text TEXT NOT NULL,
    trigger_type TEXT,
    viewer_target_id TEXT,
    model_name TEXT,
    token_usage_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_time ON bot_messages(occurred_at DESC);
  `,

  /* v2 — idempotency, persisted cooldowns, health tracking */
  `
  -- Event idempotency: prevent duplicate ingestion on reconnect
  ALTER TABLE events ADD COLUMN event_hash TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_hash ON events(event_hash);

  -- Action idempotency: prevent double-execution
  ALTER TABLE action_logs ADD COLUMN idempotency_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idempotency ON action_logs(idempotency_key);

  -- Persisted cooldowns: survive restarts
  CREATE TABLE IF NOT EXISTS cooldowns (
    key TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Runtime health snapshots: track subsystem health over time
  CREATE TABLE IF NOT EXISTS health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    chat_connected INTEGER NOT NULL DEFAULT 0,
    llm_healthy INTEGER NOT NULL DEFAULT 1,
    helix_healthy INTEGER NOT NULL DEFAULT 1,
    compaction_healthy INTEGER NOT NULL DEFAULT 1,
    auth_state TEXT NOT NULL DEFAULT 'unauthenticated',
    config_age_seconds INTEGER,
    active_viewers INTEGER NOT NULL DEFAULT 0,
    events_ingested INTEGER NOT NULL DEFAULT 0,
    replies_sent INTEGER NOT NULL DEFAULT 0,
    actions_denied INTEGER NOT NULL DEFAULT 0,
    actions_executed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_health_time ON health_snapshots(captured_at DESC);

  -- Compaction state: prevent overlapping runs
  CREATE TABLE IF NOT EXISTS compaction_state (
    key TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_event_id INTEGER,
    status TEXT NOT NULL DEFAULT 'idle'
  );
  `,
];
