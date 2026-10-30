import { processOne, cancelJob, retryJob, queueStats, listJobs, recoverOrphanedJobs, type JobType } from '../lib/queue.js';
import { registerPipelineJobs, registerScoringJob, registerRenderJobs, enqueueProjectPipeline } from '../services/pipeline.js';
import { logger } from '../lib/log.js';

let interval: NodeJS.Timeout | null = null;
let stopping = false;

export function registerWorkers(): void {
  registerPipelineJobs();
  registerScoringJob();
  registerRenderJobs();
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

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    let alive = true;
    while (alive && !stopping) alive = await processOne();
  } catch (err: any) {
    logger.error('QUEUE', `worker tick crashed: ${err?.message}`);
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    busy = false;
  }
}

export { enqueueProjectPipeline, cancelJob, retryJob, queueStats, listJobs };
export type { JobType };
