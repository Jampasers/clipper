import { processOne, cancelJob, retryJob, queueStats, listJobs, recoverOrphanedJobs, JOB_LANES, type JobType, type JobLane } from '../lib/queue.js';
import { registerPipelineJobs, registerScoringJob, registerRenderJobs, enqueueProjectPipeline } from '../services/pipeline.js';
import { registerLearningJobs } from '../services/reference-jobs.js';
import { registerDesignJobs } from '../services/design-jobs.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';

let interval: NodeJS.Timeout | null = null;
let stopping = false;

export function registerWorkers(): void {
  registerPipelineJobs();
  registerScoringJob();
  registerRenderJobs();
  registerLearningJobs();
  registerDesignJobs();
}

/**
 * Per-lane concurrency (default 1 everywhere). Video is always clamped to at
 * least 1 and its drain starts first, so video jobs are never starved by
 * design/campaign work.
 */
function laneConcurrency(lane: JobLane): number {
  const design = getSettings('design');
  const configured = design.concurrency?.[lane] ?? 1;
  return Math.max(1, Math.min(4, Math.round(configured)));
}

/** Run worker loop. Returns a stop function. */
export function startWorker(intervalMs = 1500): () => void {
  if (interval) return () => stopWorker();
  stopping = false;
  const recovered = recoverOrphanedJobs();
  if (recovered) logger.info('QUEUE', `requeued ${recovered} job(s) orphaned by a previous run`);
  interval = setInterval(tick, intervalMs);
  setTimeout(tick, 0);
  logger.info('QUEUE', `worker started (interval ${intervalMs}ms)`);
  return () => stopWorker();
}

function stopWorker(): void {
  stopping = true;
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  logger.info('QUEUE', 'worker stopped');
}

let busy = false;
const activePerLane: Record<JobLane, number> = { video: 0, design: 0, campaign: 0 };

async function drainOne(lane: JobLane): Promise<void> {
  try {
    let alive = true;
    while (alive && !stopping) alive = await processOne(lane);
  } catch (err: any) {
    logger.error('QUEUE', `${lane} lane crashed: ${err?.message}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function drainLane(lane: JobLane): void {
  const max = laneConcurrency(lane);
  while (activePerLane[lane] < max) {
    activePerLane[lane]++;
    void drainOne(lane).finally(() => {
      activePerLane[lane]--;
    });
  }
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Video first, then independent design/campaign lanes. A long browser render
    // or image-generation call can never block the video pipeline.
    for (const lane of JOB_LANES) drainLane(lane);
  } finally {
    busy = false;
  }
}

export { enqueueProjectPipeline, cancelJob, retryJob, queueStats, listJobs };
export type { JobType };
