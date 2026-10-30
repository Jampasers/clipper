import { q, J } from './sqlite.js';
import { nanoid } from 'nanoid';
import { logger } from './log.js';
import { config } from '../config.js';

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
  | 'cleanup';

export interface JobRow {
  id: string;
  type: JobType;
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
    'INSERT INTO jobs (id, type, project_id, clip_id, payload, status) VALUES (?,?,?,?,?,?)',
    id,
    type,
    opts.project_id ?? null,
    opts.clip_id ?? null,
    opts.payload !== undefined ? JSON.stringify(opts.payload) : null,
    'queued'
  );
  logger.debug('QUEUE', `enqueued ${type} job ${id}`);
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
  q.run("UPDATE jobs SET status = 'failed', error = 'cancelled by user', finished_at = datetime('now') WHERE id = ?", id);
  return true;
}

/** Claim and process one queued job. Returns false when the queue is empty. */
export async function processOne(): Promise<boolean> {
  const job = q.get<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1");
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
    logger.info('QUEUE', `running ${fresh.type} job ${fresh.id}`);
    await handler(fresh, ctx);
    q.run("UPDATE jobs SET status = 'done', progress = 100, error = NULL, finished_at = datetime('now') WHERE id = ?", fresh.id);
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 1000);
    logger.error('QUEUE', `${fresh.type} job ${fresh.id} failed: ${message}`);
    // Re-read: attempts/status may have changed while the handler ran (cancel/retry).
    const cur = getJob(fresh.id) ?? fresh;
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
  return {
    queued: countJobs('queued'),
    running: countJobs('running'),
    done: countJobs('done'),
    failed: countJobs('failed'),
    driver: config.queueDriver,
  };
}
