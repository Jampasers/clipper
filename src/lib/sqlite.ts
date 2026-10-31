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
`);
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
