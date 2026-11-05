import { q, J } from './sqlite.js';
import { nanoid } from 'nanoid';
import { logger } from './log.js';
import { config } from '../config.js';
import { killJob } from './ffmpeg.js';

/**
 * Job queue. Default driver is SQLite (no external service needed for a
 * single local PC). Set QUEUE_DRIVER=redis to use BullMQ/Redis. throws with a
 * clear message if Redis is requested but not reachable.
 */

export type JobType =
  | 'download'
  | 'probe'
  | 'transcription'
  | 'analysis'
  | 'candidate_generation'
  | 'scoring'
  | 'render_preview'
  | 'render_final'
  | 'cleanup'
  | 'reference_analysis'
  | 'reference_download'
  | 'learning_update'
  | 'design_generate'
  | 'design_variants'
  | 'design_review'
  | 'design_repair'
  | 'design_export'
  | 'social_batch'
  | 'campaign_generate';

/**
 * Workload lanes: the video lane is the legacy queue and must keep running
 * exactly as before. Design/campaign jobs run on their own lanes so a long
 * browser render or image generation can never block or starve video jobs.
 */
export type JobLane = 'video' | 'design' | 'campaign';

const DESIGN_TYPES = new Set<JobType>(['design_generate', 'design_variants', 'design_review', 'design_repair', 'design_export', 'social_batch']);
const CAMPAIGN_TYPES = new Set<JobType>(['campaign_generate']);

/** Lane is derived from the job type; legacy types (and rows without a lane) are 'video'. */
export function laneForType(type: JobType): JobLane {
  if (DESIGN_TYPES.has(type)) return 'design';
  if (CAMPAIGN_TYPES.has(type)) return 'campaign';
  return 'video';
}

export const JOB_LANES: JobLane[] = ['video', 'design', 'campaign'];

export interface JobRow {
  id: string;
  type: JobType;
  lane: JobLane;
  project_id: string | null;
  clip_id: string | null;
  payload: string | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type JobHandler = (job: JobRow, ctx: { report: (p: number) => void }) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();
let running = false;
let stopping = false;

export function registerHandler(type: JobType, handler: JobHandler) {
  handlers.set(type, handler);
}

export function enqueue(type: JobType, opts: { project_id?: string; clip_id?: string; payload?: unknown } = {}): string {
  const id = nanoid(12);
  q.run(
    'INSERT INTO jobs (id, type, lane, project_id, clip_id, payload, status) VALUES (?,?,?,?,?,?,?)',
    id,
    type,
    laneForType(type),
    opts.project_id ?? null,
    opts.clip_id ?? null,
    opts.payload !== undefined ? JSON.stringify(opts.payload) : null,
    'queued'
  );
  logger.debug('QUEUE', `enqueued ${type} job ${id} (lane ${laneForType(type)})`);
  return id;
}

export function getJob(id: string): JobRow | undefined {
  return q.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
}

export function listJobs(limit = 50): JobRow[] {
  return q.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', limit);
}

export function retryJob(id: string): boolean {
  const job = getJob(id);
  if (!job) return false;
  q.run(
    "UPDATE jobs SET status = 'queued', progress = 0, error = NULL, attempts = 0, started_at = NULL, finished_at = NULL WHERE id = ?",
    id
  );
  logger.info('QUEUE', `retry requested for ${job.type} job ${id}`);
  return true;
}

export function cancelJob(id: string): boolean {
  const job = getJob(id);
  if (!job || job.status === 'done') return false;
  killJob(id); // terminate a running ffmpeg child, if any
  q.run("UPDATE jobs SET status = 'failed', error = 'cancelled by user', finished_at = datetime('now') WHERE id = ?", id);
  return true;
}

/** Claim and process one queued job. Returns false when the queue is empty.
 *  When a lane is given only that lane is claimed (legacy callers pass nothing
 *  and keep the original any-type behavior). */
export async function processOne(lane?: JobLane): Promise<boolean> {
  const job = lane
    ? q.get<JobRow>("SELECT * FROM jobs WHERE status = 'queued' AND lane = ? ORDER BY created_at ASC, rowid ASC LIMIT 1", lane)
    : q.get<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1");
  if (!job) return false;
  const claimed = q.run(
    "UPDATE jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
    job.id
  );
  if (claimed.changes === 0) return false;

  const fresh = getJob(job.id)!;
  const handler = handlers.get(fresh.type as JobType);
  const ctx = {
    report: (p: number) => {
      q.run('UPDATE jobs SET progress = ? WHERE id = ?', Math.max(0, Math.min(100, Math.round(p))), fresh.id);
    },
  };

  try {
    if (!handler) throw new Error(`No handler registered for job type ${fresh.type}`);
    logger.info('QUEUE', `running ${fresh.type} job ${fresh.id} (lane ${fresh.lane})`);
    await handler(fresh, ctx);
    // Do not resurrect a job the user cancelled while the handler was running.
    q.run("UPDATE jobs SET status = 'done', progress = 100, error = NULL, finished_at = datetime('now') WHERE id = ? AND status = 'running'", fresh.id);
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 1000);
    logger.error('QUEUE', `${fresh.type} job ${fresh.id} failed: ${message}`);
    // Re-read: attempts/status may have changed while the handler ran (cancel/retry).
    const cur = getJob(fresh.id) ?? fresh;
    if (cur.status === 'failed' && cur.error === 'cancelled by user') return true; // user cancel wins
    const maxed = cur.attempts >= cur.max_attempts;
    q.run(
      `UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
      maxed ? 'failed' : 'queued',
      message,
      maxed ? new Date().toISOString() : null,
      fresh.id
    );
  }
  return true;
}

/** Requeue jobs left 'running' by a previous process (crash/restart mid-job). */
export function recoverOrphanedJobs(): number {
  return Number(q.run("UPDATE jobs SET status = 'queued', progress = 0, started_at = NULL WHERE status = 'running'").changes);
}

/** How many jobs currently sit in a given status. */
export function countJobs(status: JobRow['status']): number {
  const row = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE status = ?', status);
  return row?.n ?? 0;
}

export function queueStats() {
  const rows = q.all<{ lane: JobLane; status: string; n: number }>(
    'SELECT lane, status, COUNT(*) AS n FROM jobs GROUP BY lane, status'
  );
  const perLane: Record<JobLane, { queued: number; running: number; done: number; failed: number }> = {
    video: { queued: 0, running: 0, done: 0, failed: 0 },
    design: { queued: 0, running: 0, done: 0, failed: 0 },
    campaign: { queued: 0, running: 0, done: 0, failed: 0 },
  };
  for (const r of rows) {
    const bucket = perLane[r.lane] ?? perLane.video;
    if (r.status === 'queued' || r.status === 'running' || r.status === 'done' || r.status === 'failed') {
      bucket[r.status] += r.n;
    }
  }
  return {
    queued: countJobs('queued'),
    running: countJobs('running'),
    done: countJobs('done'),
    failed: countJobs('failed'),
    lanes: perLane,
    driver: config.queueDriver,
  };
}
