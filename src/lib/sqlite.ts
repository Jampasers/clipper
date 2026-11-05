import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export let db: DatabaseSync;

export function initDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(config.dbName), { recursive: true });
  db = new DatabaseSync(config.dbName);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync) {
  d.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UPLOADED',
  meta TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  language TEXT,
  segments TEXT NOT NULL,
  text TEXT NOT NULL,
  duration REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  title TEXT,
  hook TEXT,
  reason TEXT,
  scores TEXT,
  overall REAL,
  status TEXT NOT NULL DEFAULT 'candidate',
  aspect TEXT,
  subtitle_preset TEXT,
  boundary TEXT,
  emphasis TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  output_path TEXT,
  error TEXT,
  settings TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_clip ON render_jobs(clip_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project_id TEXT,
  clip_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

/* ---- AI editing upgrade (additive migrations) ---- */

CREATE TABLE IF NOT EXISTS watermarks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_path TEXT,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  default_position TEXT NOT NULL DEFAULT 'bottom-right',
  width_percent REAL NOT NULL DEFAULT 18,
  opacity REAL NOT NULL DEFAULT 0.85,
  margin INTEGER NOT NULL DEFAULT 36,
  x INTEGER,
  y INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watermarks_enabled ON watermarks(enabled);

CREATE TABLE IF NOT EXISTS music_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  mood TEXT,
  genre TEXT,
  energy INTEGER NOT NULL DEFAULT 3,
  bpm REAL,
  duration REAL,
  license TEXT,
  attribution TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_music_enabled ON music_assets(enabled);

CREATE TABLE IF NOT EXISTS editing_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  options_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_editing_plans_key ON editing_plans(clip_id, options_hash);

CREATE TABLE IF NOT EXISTS render_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS render_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  options TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_render_snapshots_clip ON render_snapshots(clip_id);

/* ---- AI creative editor (additive migrations) ---- */

CREATE TABLE IF NOT EXISTS broll_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video',
  width INTEGER,
  height INTEGER,
  duration REAL,
  tags TEXT,
  source TEXT,
  license TEXT,
  attribution TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_broll_enabled ON broll_assets(enabled);

CREATE TABLE IF NOT EXISTS sound_effects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration REAL,
  tags TEXT,
  source TEXT,
  license TEXT,
  attribution TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sfx_enabled ON sound_effects(enabled);

/* ---- Visual learning system (additive migrations) ---- */

CREATE TABLE IF NOT EXISTS reference_library (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  tags TEXT,
  source_path TEXT NOT NULL,
  thumbnail_path TEXT,
  mime TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'uploaded',
  analysis_version INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reference_status ON reference_library(status);
CREATE INDEX IF NOT EXISTS idx_reference_category ON reference_library(category);

CREATE TABLE IF NOT EXISTS reference_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_id TEXT NOT NULL REFERENCES reference_library(id) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL,
  analysis_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  profile TEXT,
  measurements TEXT,
  evidence TEXT,
  model TEXT,
  prompt_meta TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(reference_id, analysis_version)
);
CREATE INDEX IF NOT EXISTS idx_reference_analyses_ref ON reference_analyses(reference_id);

CREATE TABLE IF NOT EXISTS reference_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_id TEXT NOT NULL REFERENCES reference_library(id) ON DELETE CASCADE,
  clip_id TEXT,
  project_id TEXT,
  job_id TEXT,
  score REAL,
  features TEXT,
  outcome TEXT,
  outcome_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reference_usage_ref ON reference_usage(reference_id);
CREATE INDEX IF NOT EXISTS idx_reference_usage_clip ON reference_usage(clip_id);

CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'explicit',
  feature TEXT NOT NULL,
  prev_value TEXT,
  new_value TEXT,
  value_kind TEXT,
  clip_id TEXT,
  project_id TEXT,
  job_id TEXT,
  context TEXT,
  weight REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_learning_events_status ON learning_events(status);
CREATE INDEX IF NOT EXISTS idx_learning_events_feature ON learning_events(feature, context);

CREATE TABLE IF NOT EXISTS learning_preferences (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  context_key TEXT NOT NULL DEFAULT '',
  value TEXT,
  value_kind TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  explicit_observations INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'learned',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_preferences_feature ON learning_preferences(feature, context_key);

CREATE TABLE IF NOT EXISTS learning_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  events_processed INTEGER NOT NULL DEFAULT 0,
  preferences_updated INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT,
  detail TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS preference_snapshots (
  id TEXT PRIMARY KEY,
  reason TEXT,
  run_id TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_experience (
  id TEXT PRIMARY KEY,
  clip_id TEXT,
  project_id TEXT,
  job_id TEXT,
  context_key TEXT,
  decision TEXT,
  modification TEXT,
  render_result TEXT,
  feedback TEXT,
  references_used TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_experience_clip ON learning_experience(clip_id);

/* ---- AI Creative Studio: Design Studio (additive migrations) ---- */

CREATE TABLE IF NOT EXISTS design_documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  document TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  category TEXT,
  tags TEXT,
  brief TEXT,
  thumbnail_path TEXT,
  job_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_design_documents_status ON design_documents(status);
CREATE INDEX IF NOT EXISTS idx_design_documents_category ON design_documents(category);

CREATE TABLE IF NOT EXISTS design_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id TEXT NOT NULL REFERENCES design_documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(design_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_design_versions_design ON design_versions(design_id);

CREATE TABLE IF NOT EXISTS design_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  tags TEXT,
  source TEXT NOT NULL DEFAULT 'upload',
  generator TEXT,
  prompt TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_design_assets_kind ON design_assets(kind, enabled);

CREATE TABLE IF NOT EXISTS design_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  document TEXT NOT NULL,
  thumbnail_path TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_design_templates_category ON design_templates(category);

CREATE TABLE IF NOT EXISTS design_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id TEXT NOT NULL REFERENCES design_documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'deterministic',
  score REAL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_design_reviews_design ON design_reviews(design_id);

CREATE TABLE IF NOT EXISTS design_generations (
  id TEXT PRIMARY KEY,
  design_id TEXT,
  kind TEXT NOT NULL,
  brief TEXT,
  options TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_design_generations_design ON design_generations(design_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brief TEXT,
  brand TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_outputs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  design_id TEXT REFERENCES design_documents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_outputs_campaign ON campaign_outputs(campaign_id);
`);

  // Queue lanes: additive, nullable/defaulted column so existing rows stay valid.
  addColumnIfMissing(d, 'jobs', 'lane', "TEXT NOT NULL DEFAULT 'video'");
  d.exec('CREATE INDEX IF NOT EXISTS idx_jobs_lane_status ON jobs(lane, status);');
}

function addColumnIfMissing(d: DatabaseSync, table: string, column: string, ddl: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

/* ---- tiny query helpers ---- */
export const q = {
  get: <T = any>(sql: string, ...args: any[]): T | undefined =>
    d_prepare(sql).get(...args) as T | undefined,
  all: <T = any>(sql: string, ...args: any[]): T[] =>
    d_prepare(sql).all(...args) as T[],
  run: (sql: string, ...args: any[]) => d_prepare(sql).run(...args),
};

function d_prepare(sql: string) {
  return db.prepare(sql);
}

export const J = {
  read: <T = any>(v: string | null | undefined): T | undefined => {
    if (v == null) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  },
  write: (v: unknown) => (v == null ? null : JSON.stringify(v)),
};
