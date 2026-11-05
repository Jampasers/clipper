import { enqueue, registerHandler } from '../lib/queue.js';
import { q } from '../lib/sqlite.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { ytdlpDownload } from '../lib/ytdlp.js';
import { analyzeReference } from './reference-analysis.js';
import {
  finalizeDownloadedReference, getReference, referenceDir, setReferenceStatus, writeReferenceMeta,
} from './reference-library.js';
import { runLearningUpdate } from './learning.js';

/**
 * Worker handlers for the learning system's background jobs:
 *  - reference_download: fetch a link (YouTube/TikTok/Instagram/...) into the library
 *  - reference_analysis: vision + measurement analysis of one reference video
 *  - learning_update: preference recompute after feedback events
 */

export function enqueueReferenceAnalysis(referenceId: string, force = false): string {
  const existing = q.get<{ id: string }>(
    "SELECT id FROM jobs WHERE type = 'reference_analysis' AND status IN ('queued','running') AND payload LIKE ? LIMIT 1",
    `%"referenceId":"${referenceId}"%`
  );
  if (existing && !force) return existing.id;
  return enqueue('reference_analysis', { payload: { referenceId, force } });
}

export function enqueueLearningUpdate(kind: 'feedback' | 'rebuild' = 'feedback'): string {
  return enqueue('learning_update', { payload: { kind } });
}

export function registerLearningJobs(): void {
  registerHandler('reference_download', async (job, ctx) => {
    const payload = job.payload ? (JSON.parse(job.payload) as { referenceId?: string; url?: string }) : {};
    if (!payload.referenceId || !payload.url) throw new Error('reference_download payload incomplete');
    if (!getReference(payload.referenceId)) throw new Error(`reference ${payload.referenceId} not found`);
    ctx.report(3);
    try {
      const { file } = await ytdlpDownload(payload.url, referenceDir(payload.referenceId), (line) => {
        const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
        if (m) ctx.report(Math.min(60, 3 + Number(m[1]) * 0.55));
      });
      ctx.report(62);
      finalizeDownloadedReference(payload.referenceId, file);
    } catch (e) {
      setReferenceStatus(payload.referenceId, 'failed', String((e as Error).message).slice(0, 300));
      writeReferenceMeta(payload.referenceId);
      throw e;
    }
    if (getSettings('learning').auto_analyze) {
      await analyzeReference(payload.referenceId, {
        report: (p) => ctx.report(Math.max(63, Math.min(99, Math.round(62 + p * 0.37)))),
      });
    }
    logger.info('VIDEO', `reference_download job done: ${payload.referenceId}`);
  });

  registerHandler('reference_analysis', async (job, ctx) => {
    const payload = job.payload ? (JSON.parse(job.payload) as { referenceId?: string; force?: boolean }) : {};
    if (!payload.referenceId) throw new Error('reference_analysis payload missing referenceId');
    if (!getReference(payload.referenceId)) throw new Error(`reference ${payload.referenceId} not found`);
    ctx.report(2);
    await analyzeReference(payload.referenceId, {
      force: payload.force ?? false,
      report: (p) => ctx.report(Math.max(3, Math.min(99, Math.round(p)))),
    });
    logger.info('AI', `reference_analysis job done: ${payload.referenceId}`);
  });

  registerHandler('learning_update', async (job) => {
    const payload = job.payload ? (JSON.parse(job.payload) as { kind?: 'feedback' | 'rebuild' }) : {};
    runLearningUpdate(payload.kind ?? 'feedback');
  });
}

/** Analyze inline (upload route when auto-analyze is on but no worker is running). */
export async function analyzeNow(referenceId: string): Promise<void> {
  if (!getReference(referenceId)) throw new Error(`reference ${referenceId} not found`);
  await analyzeReference(referenceId, {});
}
