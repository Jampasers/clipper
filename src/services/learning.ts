import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { q, J } from '../lib/sqlite.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';
import { enqueue } from '../lib/queue.js';
import { generate } from '../lib/ai.js';
import { getClip } from './clips.js';
import { TIERS, tierRank, rankToTier, type Tier } from './style-profile.js';

/**
 * Visual Learning Memory + deterministic Learning Engine.
 *
 * Three memories:
 *  - reference memory   -> reference_analyses (profiles, feature confidence)
 *  - preference memory  -> learning_preferences (global + context-specific)
 *  - experience memory  -> learning_experience (decision -> modification -> result)
 *
 * Learning events capture every feedback signal. Aggregation is a deterministic
 * full recompute over all retained events (idempotent, reproducible); the LLM is
 * never allowed to write the preference DB directly. Every mutation is preceded
 * by a snapshot, so previous preference versions are recoverable.
 */

export const PREFERENCE_FEATURES = [
  'zoom_intensity',
  'zoom_frequency',
  'subtitle_style',
  'subtitle_density',
  'color_grade',
  'transition_preference',
  'broll_density',
  'sfx_density',
  'music_intensity',
  'pacing',
  'motion_graphics',
  'visual_complexity',
] as const;
export type PreferenceFeature = (typeof PREFERENCE_FEATURES)[number];

export const EVENT_FEATURES = [...PREFERENCE_FEATURES, 'overall'] as const;
export type EventFeature = (typeof EVENT_FEATURES)[number];

export const EVENT_TYPES = [
  'like',
  'dislike',
  'manual_change',
  'regeneration',
  'render_feedback',
  'reject',
  'mode_override',
  'reference_feedback',
] as const;
export type LearningEventType = (typeof EVENT_TYPES)[number];

export type ValueKind = 'numeric' | 'categorical' | 'tier';

export interface FeatureSpec {
  kind: ValueKind;
  /** allowed categorical values (for sanitization) */
  options?: readonly string[];
}

const DENSITY_OPTIONS = ['none', ...TIERS] as const;
const SUBTITLE_STYLE_OPTIONS = ['ai', 'bold', 'karaoke', 'kinetic', 'minimal', 'classic', 'none'] as const;
const GRADE_OPTIONS = ['none', 'warm', 'cool', 'vivid', 'cinematic'] as const;

export const FEATURE_SPECS: Record<PreferenceFeature, FeatureSpec> = {
  zoom_intensity: { kind: 'numeric' },
  zoom_frequency: { kind: 'tier' },
  subtitle_style: { kind: 'categorical', options: SUBTITLE_STYLE_OPTIONS },
  subtitle_density: { kind: 'categorical', options: DENSITY_OPTIONS },
  color_grade: { kind: 'categorical', options: GRADE_OPTIONS },
  transition_preference: { kind: 'categorical', options: ['cut', 'fade', 'slide'] },
  broll_density: { kind: 'categorical', options: DENSITY_OPTIONS },
  sfx_density: { kind: 'categorical', options: DENSITY_OPTIONS },
  music_intensity: { kind: 'categorical', options: DENSITY_OPTIONS },
  pacing: { kind: 'categorical', options: ['slow', 'medium', 'fast'] },
  motion_graphics: { kind: 'categorical', options: DENSITY_OPTIONS },
  visual_complexity: { kind: 'categorical', options: ['low', 'medium', 'high'] },
};

export function isPreferenceFeature(v: unknown): v is PreferenceFeature {
  return typeof v === 'string' && (PREFERENCE_FEATURES as readonly string[]).includes(v);
}

/* ---------------- value normalization ---------------- */

export interface NormalizedValue {
  kind: ValueKind;
  value: string | number;
}

/** Sanitize an external value against the feature spec; null when invalid. */
export function normalizeFeatureValue(feature: PreferenceFeature, raw: unknown): NormalizedValue | null {
  const spec = FEATURE_SPECS[feature];
  if (spec.kind === 'numeric') {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return null;
    return { kind: 'numeric', value: Math.min(1, Math.max(0, Math.round(n * 1000) / 1000)) };
  }
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (!v) return null;
  if (spec.kind === 'tier') {
    const tier = (TIERS as readonly string[]).includes(v) ? (v as Tier) : null;
    if (!tier) return null;
    return { kind: 'tier', value: tier };
  }
  if (spec.options && !(spec.options as readonly string[]).includes(v)) return null;
  return { kind: 'categorical', value: v };
}

export function valueLabel(v: NormalizedValue | null | undefined): string {
  if (!v) return 'none';
  return String(v.value);
}

/* ---------------- context detection ---------------- */

const CONTEXT_KEYWORDS: Record<string, string[]> = {
  gaming: ['game', 'gameplay', 'gaming', 'fps', 'stream', 'level', 'boss', 'gamer', 'valorant', 'minecraft', 'dota', 'pubg', 'cs2', 'ranked', 'highlights'],
  podcast: ['podcast', 'episode', 'host', 'guest', 'conversation', 'interview podcast', 'talk show'],
  interview: ['interview', 'q&a', 'questions', 'answers', 'reporter', 'journalist'],
  educational: ['learn', 'lesson', 'explain', 'explained', 'class', 'course', 'study', 'education', 'teacher', 'student'],
  tutorial: ['tutorial', 'how to', 'step by step', 'guide', 'walkthrough', 'diy', 'setup'],
  cinematic: ['cinematic', 'film', 'trailer', 'short film', 'movie', 'documentary'],
  fitness: ['workout', 'fitness', 'gym', 'exercise', 'training', 'muscle', 'run', 'yoga'],
  tech: ['tech', 'software', 'coding', 'programming', 'developer', 'app', 'ai', 'gadget', 'review'],
  comedy: ['comedy', 'funny', 'skit', 'prank', 'joke', 'standup'],
  music: ['music', 'song', 'cover', 'singing', 'beat', 'album', 'concert'],
  news: ['news', 'breaking', 'report', 'politics', 'election', 'economy'],
  vlog: ['vlog', 'day in the life', 'travel', 'daily', 'routine'],
  social: ['shorts', 'tiktok', 'reels', 'instagram', 'social media', 'viral'],
};

/** Deterministic content-context key from title/transcript text. '' = global. */
export function detectContextKey(input: { title?: string | null; transcriptText?: string | null; category?: string | null }): string {
  if (input.category) {
    const c = input.category.trim().toLowerCase();
    if (c) return c;
  }
  const text = `${input.title ?? ''}\n${(input.transcriptText ?? '').slice(0, 6000)}`.toLowerCase();
  const tokens = new Set(text.split(/[^a-z0-9&]+/).filter(Boolean));
  let best = '';
  let bestScore = 0;
  for (const [key, words] of Object.entries(CONTEXT_KEYWORDS)) {
    let score = 0;
    for (const w of words) {
      if (w.includes(' ')) score += text.includes(w) ? 2 : 0;
      else score += tokens.has(w) ? 1 : 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return bestScore >= 1 ? best : '';
}

/* ---------------- learning events ---------------- */

export interface LearningEventInput {
  eventType: LearningEventType | string;
  feature?: string;
  source?: 'explicit' | 'implicit';
  prevValue?: unknown;
  newValue?: unknown;
  clipId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  context?: Record<string, unknown>;
  contextKey?: string;
  weight?: number;
  dedupeKey?: string;
}

export interface LearningEventRow {
  id: string;
  event_type: string;
  source: 'explicit' | 'implicit';
  feature: string;
  prev_value: string | null;
  new_value: string | null;
  value_kind: string | null;
  clip_id: string | null;
  project_id: string | null;
  job_id: string | null;
  context: string | null;
  weight: number;
  status: 'pending' | 'processed' | 'ignored';
  dedupe_key: string;
  created_at: string;
  processed_at: string | null;
}

function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function defaultDedupeKey(input: LearningEventInput, feature: string): string {
  const basis = [input.eventType, feature, input.clipId ?? '', input.jobId ?? '', canonicalJson(input.newValue)];
  return crypto.createHash('sha1').update(basis.join('|')).digest('hex');
}

/**
 * Record a feedback signal. Idempotent: a repeated identical event (same dedupe
 * key) is silently coalesced. Never throws on validation — invalid feature/value
 * pairs are stored against `overall` so the raw signal is not lost.
 */
export function recordLearningEvent(input: LearningEventInput): { id: string; inserted: boolean } {
  let feature = input.feature && (input.feature === 'overall' || isPreferenceFeature(input.feature)) ? input.feature : 'overall';
  let normalized: NormalizedValue | null = null;
  if (isPreferenceFeature(feature)) {
    normalized = normalizeFeatureValue(feature, input.newValue);
    if (normalized === null) feature = 'overall'; // keep the event, drop the unparsable value mapping
  }
  const id = nanoid(12);
  const dedupeKey = (input.dedupeKey ?? defaultDedupeKey(input, feature)).slice(0, 200);
  const weight = Number.isFinite(input.weight as number) ? Math.max(0.05, Math.min(10, input.weight as number)) : 1;
  const res = q.run(
    `INSERT OR IGNORE INTO learning_events
       (id, event_type, source, feature, prev_value, new_value, value_kind, clip_id, project_id, job_id, context, weight, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    String(input.eventType),
    input.source === 'explicit' ? 'explicit' : 'implicit',
    feature,
    input.prevValue === undefined ? null : canonicalJson(input.prevValue),
    normalized ? canonicalJson(normalized.value) : input.newValue === undefined ? null : canonicalJson(input.newValue),
    normalized?.kind ?? null,
    input.clipId ?? null,
    input.projectId ?? null,
    input.jobId ?? null,
    input.context || input.contextKey ? JSON.stringify({ ...(input.context ?? {}), contextKey: input.contextKey ?? detectContextKey({}) }) : null,
    weight,
    dedupeKey
  );
  const inserted = Number(res.changes) > 0;
  if (!inserted) {
    const existing = q.get<{ id: string }>('SELECT id FROM learning_events WHERE dedupe_key = ?', dedupeKey);
    return { id: existing?.id ?? id, inserted: false };
  }
  logger.debug('AI', `learning event recorded: ${input.eventType} ${feature}=${normalized ? valueLabel(normalized) : 'n/a'} (${input.source ?? 'implicit'})`);
  maybeEnqueueLearningUpdate();
  return { id, inserted: true };
}

/** Debounced automatic learning: one queued learning_update at a time. */
export function maybeEnqueueLearningUpdate(): void {
  if (!getSettings('learning').enabled) return;
  const active = q.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE type = 'learning_update' AND status IN ('queued','running')"
  );
  if ((active?.n ?? 0) > 0) return;
  enqueue('learning_update', { payload: { kind: 'feedback' } });
}

/* ---------------- preference aggregation (deterministic) ---------------- */

export interface AggregatedPreference {
  feature: PreferenceFeature;
  contextKey: string;
  value: NormalizedValue;
  confidence: number;
  observations: number;
  explicitObservations: number;
}

interface WeightedValue {
  nv: NormalizedValue;
  weight: number;
  explicit: boolean;
}

export interface AggregateOptions {
  explicitWeight?: number;
  implicitWeight?: number;
}

/**
 * Deterministic aggregation for one (feature, context) group.
 * Confidence = consistency x coverage. Consistency measures agreement
 * (weighted mode share / 1 - normalized spread); coverage grows with the number
 * of weighted observations. No model involvement.
 */
export function aggregateGroup(feature: PreferenceFeature, contextKey: string, rows: LearningEventRow[], opts: AggregateOptions = {}): AggregatedPreference | null {
  const spec = FEATURE_SPECS[feature];
  const explicitWeight = opts.explicitWeight ?? getSettings('learning').explicit_weight;
  const implicitWeight = opts.implicitWeight ?? getSettings('learning').implicit_weight;
  const values: WeightedValue[] = [];
  for (const row of rows) {
    if (row.feature !== feature) continue;
    if (contextOf(row) !== contextKey) continue;
    const nv = normalizeFeatureValue(feature, parseStoredValue(row));
    if (!nv) continue;
    const base = row.source === 'explicit' ? explicitWeight : implicitWeight;
    values.push({ nv, weight: base * (row.weight || 1), explicit: row.source === 'explicit' });
  }
  if (!values.length) return null;
  const totalWeight = values.reduce((a, v) => a + v.weight, 0);
  const coverage = Math.min(1, totalWeight / 4);
  const observations = values.length;
  const explicitObservations = values.filter((v) => v.explicit).length;

  if (spec.kind === 'numeric') {
    const mean = values.reduce((a, v) => a + (v.nv.value as number) * v.weight, 0) / totalWeight;
    const variance = values.reduce((a, v) => a + v.weight * ((v.nv.value as number) - mean) ** 2, 0) / totalWeight;
    const std = Math.sqrt(variance);
    const consistency = Math.max(0, 1 - std / 0.35);
    const confidence = Math.round(consistency * coverage * 1000) / 1000;
    if (confidence <= 0) return null;
    return { feature, contextKey, value: { kind: 'numeric', value: Math.round(mean * 1000) / 1000 }, confidence, observations, explicitObservations };
  }

  // categorical / tier: weighted mode counts (tiers are ranked separately below)
  const counts = new Map<string, number>();
  for (const v of values) counts.set(String(v.nv.value), (counts.get(String(v.nv.value)) ?? 0) + v.weight);
  let top: [string, number] | null = null;
  for (const [k, w] of counts) if (!top || w > top[1] || (w === top[1] && k < top[0])) top = [k, w];
  if (!top) return null;
  let consistency = top[1] / totalWeight;

  if (spec.kind === 'tier') {
    // tiers: weighted mean rank smooths "high vs very_high" disagreements;
    // consistency is derived from the rank spread instead of exact agreement.
    const ranks = values.map((v) => ({ rank: tierRank(v.nv.value as Tier) ?? 0, weight: v.weight }));
    const meanRank = ranks.reduce((a, r) => a + r.rank * r.weight, 0) / totalWeight;
    const sd = Math.sqrt(ranks.reduce((a, r) => a + r.weight * (r.rank - meanRank) ** 2, 0) / totalWeight);
    consistency = Math.max(0, 1 - sd / 0.35);
    const confidence = Math.round(consistency * coverage * 1000) / 1000;
    if (confidence <= 0) return null;
    return { feature, contextKey, value: { kind: 'tier', value: rankToTier(meanRank) }, confidence, observations, explicitObservations };
  }

  const confidence = Math.round(consistency * coverage * 1000) / 1000;
  if (confidence <= 0) return null;
  return { feature, contextKey, value: { kind: 'categorical', value: top[0] }, confidence, observations, explicitObservations };
}

function parseStoredValue(row: LearningEventRow): unknown {
  if (row.value_kind === 'numeric') {
    const v = J.read<number>(row.new_value);
    return typeof v === 'number' ? v : row.new_value;
  }
  const v = J.read<unknown>(row.new_value);
  return v ?? row.new_value;
}

export function contextOf(row: LearningEventRow): string {
  return J.read<{ contextKey?: string }>(row.context)?.contextKey ?? '';
}

/* ---------------- preferences persistence ---------------- */

export interface PreferenceRow {
  id: string;
  feature: string;
  context_key: string;
  value: string | null;
  value_kind: string | null;
  confidence: number;
  observations: number;
  explicit_observations: number;
  source: 'learned' | 'manual';
  status: 'active' | 'suppressed';
  created_at: string;
  updated_at: string;
}

export function listPreferences(filters: { feature?: string; contextKey?: string; includeSuppressed?: boolean } = {}): PreferenceRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filters.feature) {
    where.push('feature = ?');
    args.push(filters.feature);
  }
  if (filters.contextKey !== undefined) {
    where.push('context_key = ?');
    args.push(filters.contextKey);
  }
  if (!filters.includeSuppressed) where.push("status = 'active'");
  return q.all<PreferenceRow>(
    `SELECT * FROM learning_preferences ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY feature ASC, context_key ASC`,
    ...args
  );
}

export function getPreference(id: string): PreferenceRow | undefined {
  return q.get<PreferenceRow>('SELECT * FROM learning_preferences WHERE id = ?', id);
}

export interface ResolvedPreference {
  feature: PreferenceFeature;
  value: NormalizedValue;
  confidence: number;
  contextKey: string;
  source: 'learned' | 'manual';
}

/**
 * Resolve effective preferences for a context. Context-specific values override
 * the global value of the same feature when their confidence clears the
 * configured threshold; global stays the fallback.
 */
export function resolvePreferences(contextKey: string, extraContexts: string[] = []): Map<PreferenceFeature, ResolvedPreference> {
  const settings = getSettings('learning');
  const rows = listPreferences({ includeSuppressed: false }).filter((r) => r.confidence >= settings.min_preference_confidence || r.source === 'manual');
  const contexts = [contextKey, ...extraContexts].filter(Boolean);
  const out = new Map<PreferenceFeature, ResolvedPreference>();
  const consider = (row: PreferenceRow, forContext: string) => {
    if (!isPreferenceFeature(row.feature)) return;
    const nv = normalizeFeatureValue(row.feature, J.read<unknown>(row.value));
    if (!nv) return;
    const existing = out.get(row.feature);
    // context-specific always beats global; among same specificity prefer manual, then confidence
    const better =
      !existing ||
      (forContext !== '' && existing.contextKey === '') ||
      (forContext === existing.contextKey && row.source === 'manual' && existing.source !== 'manual') ||
      (forContext === existing.contextKey && row.source === existing.source && row.confidence > existing.confidence);
    if (better) {
      out.set(row.feature, { feature: row.feature, value: nv, confidence: row.confidence, contextKey: forContext, source: row.source });
    }
  };
  for (const row of rows) if (row.context_key === '') consider(row, '');
  for (const ctx of contexts) for (const row of rows) if (row.context_key === ctx) consider(row, ctx);
  return out;
}

export function upsertLearnedPreference(agg: AggregatedPreference, runId: string | null): boolean {
  const existing = q.get<PreferenceRow>('SELECT * FROM learning_preferences WHERE feature = ? AND context_key = ?', agg.feature, agg.contextKey);
  if (existing?.source === 'manual' && existing.status === 'active') {
    // manual wins; learned data is retained in events (traceable, recoverable)
    return false;
  }
  const id = existing?.id ?? nanoid(12);
  q.run(
    `INSERT INTO learning_preferences (id, feature, context_key, value, value_kind, confidence, observations, explicit_observations, source, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(feature, context_key) DO UPDATE SET
       value = excluded.value, value_kind = excluded.value_kind, confidence = excluded.confidence,
       observations = excluded.observations, explicit_observations = excluded.explicit_observations,
       updated_at = datetime('now')`,
    id,
    agg.feature,
    agg.contextKey,
    JSON.stringify(agg.value.value),
    agg.value.kind,
    agg.confidence,
    agg.observations,
    agg.explicitObservations,
    'learned',
    existing?.status ?? 'active'
  );
  logger.debug('AI', `preference updated: ${agg.feature}@${agg.contextKey || 'global'} = ${valueLabel(agg.value)} (conf ${agg.confidence}, n=${agg.observations}, run ${runId ?? '-'})`);
  return true;
}

/* ---------------- snapshots (recoverability) ---------------- */

export function preferenceSnapshotDir(): string {
  const dir = path.join(config.dirs.learning, 'preference-snapshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createPreferenceSnapshot(reason: string, runId: string | null = null): string {
  const rows = q.all<PreferenceRow>('SELECT * FROM learning_preferences ORDER BY feature ASC, context_key ASC');
  const id = nanoid(12);
  const data = JSON.stringify(rows);
  q.run('INSERT INTO preference_snapshots (id, reason, run_id, data) VALUES (?,?,?,?)', id, reason, runId, data);
  try {
    fs.writeFileSync(path.join(preferenceSnapshotDir(), `${id}.json`), JSON.stringify({ id, reason, runId, rows }, null, 2), 'utf8');
  } catch (e) {
    logger.warn('SYSTEM', `could not write preference snapshot file: ${(e as Error).message}`);
  }
  return id;
}

export function listSnapshots(limit = 30): { id: string; reason: string | null; run_id: string | null; created_at: string; count: number }[] {
  return q
    .all<{ id: string; reason: string | null; run_id: string | null; created_at: string; data: string }>(
      'SELECT id, reason, run_id, created_at, data FROM preference_snapshots ORDER BY created_at DESC LIMIT ?',
      Math.min(100, Math.max(1, limit))
    )
    .map((r) => ({ id: r.id, reason: r.reason, run_id: r.run_id, created_at: r.created_at, count: (J.read<unknown[]>(r.data) ?? []).length }));
}

export function restoreSnapshot(snapshotId: string): { restored: number; snapshotId: string } {
  const snap = q.get<{ id: string; data: string }>('SELECT id, data FROM preference_snapshots WHERE id = ?', snapshotId);
  if (!snap) throw new Error('snapshot not found');
  const rows = J.read<PreferenceRow[]>(snap.data) ?? [];
  createPreferenceSnapshot(`before restore of ${snapshotId}`, null);
  q.run('DELETE FROM learning_preferences');
  for (const row of rows) {
    q.run(
      `INSERT INTO learning_preferences (id, feature, context_key, value, value_kind, confidence, observations, explicit_observations, source, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.feature,
      row.context_key,
      row.value,
      row.value_kind,
      row.confidence,
      row.observations,
      row.explicit_observations,
      row.source,
      row.status,
      row.created_at,
      row.updated_at
    );
  }
  q.run('INSERT INTO learning_runs (id, kind, status, events_processed, preferences_updated, snapshot_id, detail, finished_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\'))', nanoid(12), 'rollback', 'done', 0, rows.length, snapshotId, `restored snapshot ${snapshotId}`);
  logger.info('AI', `preferences rolled back to snapshot ${snapshotId} (${rows.length} rows)`);
  return { restored: rows.length, snapshotId };
}

export interface ResetOptions {
  feature?: PreferenceFeature;
  contextKey?: string;
  includeManual?: boolean;
}

export function resetPreferences(opts: ResetOptions = {}): { deleted: number; snapshotId: string } {
  const snapshotId = createPreferenceSnapshot('before reset', null);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.feature) {
    where.push('feature = ?');
    args.push(opts.feature);
  }
  if (opts.contextKey !== undefined) {
    where.push('context_key = ?');
    args.push(opts.contextKey);
  }
  if (!opts.includeManual) where.push("source = 'learned'");
  const res = q.run(`DELETE FROM learning_preferences ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...args);
  q.run('INSERT INTO learning_runs (id, kind, status, events_processed, preferences_updated, snapshot_id, detail, finished_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\'))', nanoid(12), 'reset', 'done', 0, Number(res.changes), snapshotId, opts.feature ? `reset ${opts.feature}@${opts.contextKey ?? '*'}` : 'reset learned preferences');
  logger.info('AI', `preferences reset (${res.changes} row(s) removed), snapshot ${snapshotId}`);
  return { deleted: Number(res.changes), snapshotId };
}

/* ---------------- learning runs (the engine) ---------------- */

export interface LearningRunResult {
  runId: string;
  kind: string;
  eventsProcessed: number;
  preferencesUpdated: number;
  snapshotId: string | null;
  insights: string[];
}

/**
 * The automatic learning engine. Processing is a full deterministic recompute:
 * every retained (non-ignored) event is re-aggregated, so repeated runs are
 * idempotent and any preference can be reproduced from history.
 */
export function runLearningUpdate(kind: 'feedback' | 'rebuild' = 'feedback'): LearningRunResult {
  const runId = nanoid(12);
  const settings = getSettings('learning');
  q.run('INSERT INTO learning_runs (id, kind, status) VALUES (?,?,?)', runId, kind, 'running');
  try {
    const events = q.all<LearningEventRow>(
      kind === 'rebuild'
        ? "SELECT * FROM learning_events WHERE status != 'ignored' ORDER BY created_at ASC"
        : "SELECT * FROM learning_events WHERE status = 'pending' ORDER BY created_at ASC"
    );
    if (!events.length && kind === 'feedback') {
      q.run("UPDATE learning_runs SET status = 'done', finished_at = datetime('now') WHERE id = ?", runId);
      return { runId, kind, eventsProcessed: 0, preferencesUpdated: 0, snapshotId: null, insights: currentInsights() };
    }

    const groups = new Map<string, LearningEventRow[]>();
    for (const ev of events) {
      if (!isPreferenceFeature(ev.feature)) continue;
      const key = `${ev.feature}\u0000${contextOf(ev)}`;
      const list = groups.get(key) ?? [];
      list.push(ev);
      groups.set(key, list);
    }

    const snapshotId = createPreferenceSnapshot(`learning run ${runId} (${kind})`, runId);
    let updated = 0;
    for (const [key, rows] of groups) {
      const [feature, contextKey] = key.split('\u0000') as [PreferenceFeature, string];
      const agg = aggregateGroup(feature, contextKey, rows, { explicitWeight: settings.explicit_weight, implicitWeight: settings.implicit_weight });
      if (!agg) continue;
      if (upsertLearnedPreference(agg, runId)) updated++;
    }

    const runEvents = kind === 'rebuild' ? events.length : events.length;
    q.run("UPDATE learning_events SET status = 'processed', processed_at = datetime('now') WHERE status = 'pending'", );
    const insights = currentInsights();
    q.run(
      `UPDATE learning_runs SET status = 'done', events_processed = ?, preferences_updated = ?, snapshot_id = ?, detail = ?, finished_at = datetime('now') WHERE id = ?`,
      runEvents,
      updated,
      snapshotId,
      JSON.stringify({ insights }),
      runId
    );
    logger.info('AI', `learning run ${kind} done: ${events.length} event(s), ${updated} preference update(s)`);
    return { runId, kind, eventsProcessed: events.length, preferencesUpdated: updated, snapshotId, insights };
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    q.run("UPDATE learning_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?", msg, runId);
    throw e;
  }
}

/* ---------------- manual preference editing ---------------- */

export function setManualPreference(feature: string, contextKey: string, rawValue: unknown, opts: { confidence?: number; status?: 'active' | 'suppressed' } = {}): PreferenceRow {
  if (!isPreferenceFeature(feature)) throw new Error(`unknown feature "${feature}"`);
  const nv = normalizeFeatureValue(feature, rawValue);
  if (!nv) throw new Error(`invalid value for ${feature}`);
  const context = (contextKey ?? '').trim().toLowerCase().slice(0, 40);
  const existing = q.get<PreferenceRow>('SELECT * FROM learning_preferences WHERE feature = ? AND context_key = ?', feature, context);
  createPreferenceSnapshot(`before manual set of ${feature}`, null);
  const id = existing?.id ?? nanoid(12);
  const confidence = opts.confidence !== undefined ? Math.min(1, Math.max(0, opts.confidence)) : 1;
  q.run(
    `INSERT INTO learning_preferences (id, feature, context_key, value, value_kind, confidence, observations, explicit_observations, source, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(feature, context_key) DO UPDATE SET
       value = excluded.value, value_kind = excluded.value_kind, confidence = excluded.confidence,
       source = 'manual', status = excluded.status, updated_at = datetime('now')`,
    id,
    feature,
    context,
    JSON.stringify(nv.value),
    nv.kind,
    confidence,
    existing?.observations ?? 0,
    Math.max(1, existing?.explicit_observations ?? 0),
    'manual',
    opts.status ?? 'active'
  );
  recordLearningEvent({
    eventType: 'manual_change',
    feature,
    source: 'explicit',
    prevValue: existing ? J.read<unknown>(existing.value) : null,
    newValue: nv.value,
    contextKey: context,
    dedupeKey: `manual:${feature}:${context}:${JSON.stringify(nv.value)}:${new Date().toISOString().slice(0, 16)}`,
  });
  logger.info('AI', `manual preference set: ${feature}@${context || 'global'} = ${valueLabel(nv)}`);
  return getPreference(id)!;
}

export function updatePreference(id: string, patch: { value?: unknown; confidence?: number; status?: 'active' | 'suppressed' }): PreferenceRow | undefined {
  const row = getPreference(id);
  if (!row) return undefined;
  if (patch.value !== undefined) {
    return setManualPreference(row.feature, row.context_key, patch.value, { confidence: patch.confidence ?? row.confidence, status: patch.status ?? row.status });
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.confidence !== undefined) {
    sets.push('confidence = ?');
    args.push(Math.min(1, Math.max(0, patch.confidence)));
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status);
  }
  if (!sets.length) return row;
  createPreferenceSnapshot(`before preference status/confidence change of ${row.feature}`, null);
  q.run(`UPDATE learning_preferences SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...args, id);
  return getPreference(id);
}

/** Remove one preference (manual or learned). Snapshotted and event-logged. */
export function deletePreference(id: string): boolean {
  const row = getPreference(id);
  if (!row) return false;
  createPreferenceSnapshot(`before deleting ${row.feature}@${row.context_key || 'global'}`, null);
  q.run('DELETE FROM learning_preferences WHERE id = ?', id);
  if (isPreferenceFeature(row.feature)) {
    recordLearningEvent({
      eventType: 'manual_change',
      feature: row.feature,
      source: 'explicit',
      prevValue: J.read<unknown>(row.value),
      newValue: null,
      contextKey: row.context_key,
      dedupeKey: `manual-delete:${id}:${new Date().toISOString().slice(0, 16)}`,
    });
  }
  logger.info('AI', `preference deleted: ${row.feature}@${row.context_key || 'global'}`);
  return true;
}

/* ---------------- experience memory ---------------- */

export interface ExperienceInput {
  clipId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  contextKey?: string;
  decision?: unknown;
  modification?: unknown;
  renderResult?: unknown;
  feedback?: unknown;
  referencesUsed?: unknown;
  outcome?: 'good' | 'bad' | 'mixed' | 'unknown';
}

export function recordExperience(input: ExperienceInput, dedupeOnJob = true): string {
  if (input.jobId && dedupeOnJob) {
    const existing = q.get<{ id: string }>('SELECT id FROM learning_experience WHERE job_id = ?', input.jobId);
    if (existing) {
      updateExperience(existing.id, input);
      return existing.id;
    }
  }
  const id = nanoid(12);
  q.run(
    `INSERT INTO learning_experience (id, clip_id, project_id, job_id, context_key, decision, modification, render_result, feedback, references_used, outcome)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.clipId ?? null,
    input.projectId ?? null,
    input.jobId ?? null,
    input.contextKey ?? '',
    canonicalJson(input.decision),
    canonicalJson(input.modification),
    canonicalJson(input.renderResult),
    canonicalJson(input.feedback),
    canonicalJson(input.referencesUsed),
    input.outcome ?? 'unknown'
  );
  return id;
}

export function updateExperience(id: string, patch: ExperienceInput): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    args.push(canonicalJson(v));
  };
  put('modification', patch.modification);
  put('render_result', patch.renderResult);
  put('feedback', patch.feedback);
  put('outcome', patch.outcome ?? undefined);
  put('references_used', patch.referencesUsed);
  put('decision', patch.decision);
  if (!sets.length) return;
  q.run(`UPDATE learning_experience SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...args, id);
}

export function updateExperienceOutcomeByJob(jobId: string, outcome: 'good' | 'bad' | 'mixed' | 'unknown', feedback?: unknown): number {
  const res = q.run(
    "UPDATE learning_experience SET outcome = ?, feedback = COALESCE(?, feedback), updated_at = datetime('now') WHERE job_id = ?",
    outcome,
    feedback !== undefined ? canonicalJson(feedback) : null,
    jobId
  );
  if (Number(res.changes) > 0) {
    q.run("UPDATE reference_usage SET outcome = ?, outcome_source = 'feedback', updated_at = datetime('now') WHERE job_id = ? AND outcome IS NULL", outcome === 'bad' ? 'bad' : 'good', jobId);
  }
  return Number(res.changes);
}

/** Outcome for usage rows of a clip (reject = negative signal). */
export function updateReferenceOutcomeByClip(clipId: string, outcome: 'good' | 'bad', source = 'feedback'): number {
  const res = q.run("UPDATE reference_usage SET outcome = ?, outcome_source = ?, updated_at = datetime('now') WHERE clip_id = ? AND outcome IS NULL", outcome, source, clipId);
  return Number(res.changes);
}

export function listExperience(limit = 50, clipId?: string): any[] {
  const rows = clipId
    ? q.all<{ id: string; clip_id: string; job_id: string; context_key: string; decision: string; modification: string; render_result: string; feedback: string; references_used: string; outcome: string; created_at: string }>(
        'SELECT * FROM learning_experience WHERE clip_id = ? ORDER BY created_at DESC LIMIT ?',
        clipId,
        Math.min(200, limit)
      )
    : q.all<{ id: string; clip_id: string; job_id: string; context_key: string; decision: string; modification: string; render_result: string; feedback: string; references_used: string; outcome: string; created_at: string }>(
        'SELECT * FROM learning_experience ORDER BY created_at DESC LIMIT ?',
        Math.min(200, limit)
      );
  return rows.map((r) => ({
    id: r.id,
    clipId: r.clip_id,
    jobId: r.job_id,
    contextKey: r.context_key,
    decision: J.read(r.decision),
    modification: J.read(r.modification),
    renderResult: J.read(r.render_result),
    feedback: J.read(r.feedback),
    referencesUsed: J.read(r.references_used),
    outcome: r.outcome,
    createdAt: r.created_at,
  }));
}

/** Deterministic insights from preference + experience memory (no model). */
export function currentInsights(limit = 8): string[] {
  const insights: string[] = [];
  const prefs = listPreferences({ includeSuppressed: false });
  for (const p of prefs) {
    if (p.source !== 'learned' || p.observations < 2) continue;
    const value = J.read<unknown>(p.value);
    const pct = Math.round(p.confidence * 100);
    insights.push(
      `Learned ${p.feature.replace(/_/g, ' ')} ${JSON.stringify(value)}${p.context_key ? ` for ${p.context_key}` : ' globally'} (${p.observations} observations, ${pct}% confidence).`
    );
  }
  const outcomes = q.get<{ bad: number; good: number }>(
    "SELECT SUM(CASE WHEN outcome='bad' THEN 1 ELSE 0 END) AS bad, SUM(CASE WHEN outcome='good' THEN 1 ELSE 0 END) AS good FROM learning_experience WHERE created_at >= datetime('now','-30 day')"
  );
  if ((outcomes?.bad ?? 0) >= 2) insights.push(`${outcomes!.bad} recent render(s) were rejected or disliked — avoid repeating those editing patterns.`);
  if ((outcomes?.good ?? 0) >= 2) insights.push(`${outcomes!.good} recent render(s) were positively received — reuse their patterns.`);
  return insights.slice(0, limit);
}

/* ---------------- stats + history ---------------- */

export interface LearningStats {
  references: { total: number; analyzed: number; partial: number; pending: number; failed: number };
  events: { total: number; pending: number; explicit: number; byType: { type: string; count: number }[] };
  preferences: { active: number; contexts: number; avgConfidence: number };
  experience: number;
  runs: { total: number; lastKind: string | null; lastAt: string | null };
  enabled: boolean;
}

export function learningStats(): LearningStats {
  const refCounts = q.get<{ total: number; analyzed: number; partial: number; failed: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'analyzed' THEN 1 ELSE 0 END) AS analyzed,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM reference_library`
  );
  const analyzed = refCounts?.analyzed ?? 0;
  const partial = refCounts?.partial ?? 0;
  const failed = refCounts?.failed ?? 0;
  const totalRefs = refCounts?.total ?? 0;
  const events = q.get<{ total: number; pending: number; explicit: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN source = 'explicit' THEN 1 ELSE 0 END) AS explicit
     FROM learning_events`
  );
  const byType = q.all<{ type: string; count: number }>('SELECT event_type AS type, COUNT(*) AS count FROM learning_events GROUP BY event_type ORDER BY count DESC LIMIT 12');
  const prefs = q.get<{ active: number; contexts: number; avgConfidence: number }>(
    "SELECT COUNT(*) AS active, COUNT(DISTINCT context_key) AS contexts, AVG(confidence) AS avgConfidence FROM learning_preferences WHERE status = 'active'"
  );
  const experience = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM learning_experience')?.n ?? 0;
  const runs = q.get<{ total: number; kind: string | null; at: string | null }>('SELECT COUNT(*) AS total, (SELECT kind FROM learning_runs ORDER BY created_at DESC LIMIT 1) AS kind, (SELECT created_at FROM learning_runs ORDER BY created_at DESC LIMIT 1) AS at FROM learning_runs');
  return {
    references: { total: totalRefs, analyzed, partial, pending: Math.max(0, totalRefs - analyzed - partial - failed), failed },
    events: { total: events?.total ?? 0, pending: events?.pending ?? 0, explicit: events?.explicit ?? 0, byType },
    preferences: {
      active: prefs?.active ?? 0,
      contexts: prefs?.contexts ?? 0,
      avgConfidence: Math.round((prefs?.avgConfidence ?? 0) * 1000) / 1000,
    },
    experience,
    runs: { total: runs?.total ?? 0, lastKind: runs?.kind ?? null, lastAt: runs?.at ?? null },
    enabled: getSettings('learning').enabled,
  };
}

export interface HistoryQuery {
  limit?: number;
  offset?: number;
  kind?: 'events' | 'runs';
  feature?: string;
  eventType?: string;
  clipId?: string;
}

export function learningHistory(query: HistoryQuery = {}): unknown {
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const offset = Math.max(0, query.offset ?? 0);
  if (query.kind === 'runs') {
    return {
      runs: q.all(
        'SELECT id, kind, status, events_processed, preferences_updated, snapshot_id, detail, error, created_at, finished_at FROM learning_runs ORDER BY created_at DESC LIMIT ? OFFSET ?',
        limit,
        offset
      ),
    };
  }
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.feature) {
    where.push('feature = ?');
    args.push(query.feature);
  }
  if (query.eventType) {
    where.push('event_type = ?');
    args.push(query.eventType);
  }
  if (query.clipId) {
    where.push('clip_id = ?');
    args.push(query.clipId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM learning_events ${clause}`, ...args)?.n ?? 0;
  const events = q
    .all<LearningEventRow>(`SELECT * FROM learning_events ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset)
    .map((r) => ({
      id: r.id,
      eventType: r.event_type,
      source: r.source,
      feature: r.feature,
      prevValue: J.read(r.prev_value),
      newValue: J.read(r.new_value),
      valueKind: r.value_kind,
      clipId: r.clip_id,
      jobId: r.job_id,
      context: J.read(r.context),
      status: r.status,
      createdAt: r.created_at,
      processedAt: r.processed_at,
    }));
  return { events, total };
}

/* ---------------- reference usage ---------------- */

export function recordReferenceUsage(input: {
  referenceId: string;
  clipId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  score: number;
  features?: unknown;
}): void {
  q.run(
    'INSERT INTO reference_usage (reference_id, clip_id, project_id, job_id, score, features) VALUES (?,?,?,?,?,?)',
    input.referenceId,
    input.clipId ?? null,
    input.projectId ?? null,
    input.jobId ?? null,
    input.score,
    canonicalJson(input.features)
  );
}

/* ---------------- cache invalidation ---------------- */

/**
 * Deterministic fingerprint of everything that can change a creative decision:
 * effective preferences, the enabled reference pool (with analysis recency) and
 * the learning settings. Adaptive plans embed it in their options hash, so a
 * learned change invalidates cached plans without touching PLAN_VERSION.
 */
export function learningFingerprint(): string {
  const prefs = [...resolvePreferences('').values()]
    .map((p) => `${p.feature}=${p.value.value}(${p.confidence.toFixed(2)},${p.source})`)
    .join('|');
  const contexts = (q
    .all<{ context_key: string }>("SELECT DISTINCT context_key FROM learning_preferences WHERE status = 'active' AND context_key != '' ORDER BY context_key")
    .map((r) => {
      const resolved = resolvePreferences(r.context_key);
      return `${r.context_key}:${[...resolved.values()].map((p) => `${p.feature}=${p.value.value}`).join(',')}`;
    })
    .join('|'));
  const refs = q.get<{ n: number; latest: string | null }>(
    "SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM reference_library WHERE enabled = 1 AND status IN ('analyzed','partial')"
  );
  const s = getSettings('learning');
  // Bump CONSTRAINTS_REV when the deterministic constraint logic changes, so
  // cached adaptive plans rebuild once (basic plans are unaffected).
  const CONSTRAINTS_REV = 3;
  return crypto
    .createHash('sha1')
    .update(
      `${s.enabled ? 1 : 0}:${s.use_references ? 1 : 0}:${s.max_references}:${s.min_preference_confidence}:${JSON.stringify(s.weights)}:${refs?.n ?? 0}:${refs?.latest ?? ''}:${prefs}:${contexts}:c${CONSTRAINTS_REV}`
    )
    .digest('hex')
    .slice(0, 12);
}

/* ---------------- explicit feedback (shared by API + Telegram) ---------------- */

export interface FeedbackInput {
  verdict: 'good' | 'bad';
  rating?: number | null;
  notes?: string;
  jobId?: string | null;
}

export interface FeedbackResult {
  ok: true;
  verdict: 'good' | 'bad';
  experienceResolved: boolean;
  classified: { feature: string; sentiment: 'positive' | 'negative'; value: unknown; reason: string } | null;
}

/**
 * Explicit feedback pipeline: resolve the latest render's experience entry,
 * mark reference-usage outcomes, store the raw event, and let the LLM map
 * free-form notes onto ONE validated style feature. The model only proposes —
 * values are normalized locally and stored as learning events; preferences are
 * written exclusively by the deterministic engine.
 */
export async function submitClipFeedback(clipId: string, input: FeedbackInput): Promise<FeedbackResult> {
  const clip = getClip(clipId);
  if (!clip) throw Object.assign(new Error('clip not found'), { status: 404 });
  const verdict = input.verdict;
  const rating = typeof input.rating === 'number' ? Math.max(0, Math.min(5, input.rating)) : null;
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';

  const jobRow = q.get<{ id: string }>(
    "SELECT id FROM jobs WHERE clip_id = ? AND type IN ('render_preview','render_final') AND status = 'done' ORDER BY created_at DESC LIMIT 1",
    clipId
  );
  const jobId = input.jobId ?? jobRow?.id ?? null;

  if (jobId) updateExperienceOutcomeByJob(jobId, verdict, { verdict, rating, notes: notes || null });
  updateReferenceOutcomeByClip(clipId, verdict, 'feedback');

  const minute = new Date().toISOString().slice(0, 16);
  recordLearningEvent({
    eventType: verdict === 'good' ? 'clip_approved' : 'clip_negative',
    feature: 'overall',
    source: 'explicit',
    clipId,
    projectId: clip.project_id ?? null,
    jobId,
    context: { verdict, rating, notes: notes || null },
    dedupeKey: `feedback:${clipId}:${jobId ?? 'nojob'}:${verdict}:${minute}`,
  });

  let classified: FeedbackResult['classified'] = null;
  if (notes && getSettings('learning').enabled) {
    try {
      const res = await generate<{ feature?: string; sentiment?: string; value?: unknown; reason?: string }>(
        'feedback_classification',
        { feedback: notes, context: JSON.stringify({ title: clip.title, verdict, rating }).slice(0, 1500) }
      );
      const json = res.json;
      if (json?.feature && json.feature !== 'none' && isPreferenceFeature(json.feature)) {
        const nv = normalizeFeatureValue(json.feature, json.value);
        if (nv) {
          const current = resolvePreferences('').get(json.feature);
          recordLearningEvent({
            eventType: 'feature_change',
            feature: json.feature,
            source: 'explicit',
            prevValue: current ? current.value.value : null,
            newValue: nv.value,
            clipId,
            projectId: clip.project_id ?? null,
            jobId,
            context: { notes, sentiment: json.sentiment ?? null },
            dedupeKey: `feedback-feature:${clipId}:${json.feature}:${JSON.stringify(nv.value)}:${minute}`,
          });
          classified = {
            feature: json.feature,
            sentiment: json.sentiment === 'negative' ? 'negative' : 'positive',
            value: nv.value,
            reason: typeof json.reason === 'string' ? json.reason.slice(0, 200) : '',
          };
        }
      }
    } catch (e) {
      // classification is best-effort; the raw feedback event above is already stored
      logger.debug('AI', `feedback classification skipped: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  maybeEnqueueLearningUpdate();
  return { ok: true, verdict, experienceResolved: !!jobId, classified };
}
