import { q } from '../lib/sqlite.js';
import { registerHandler, enqueue, type JobType } from '../lib/queue.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { getProject, setProjectStatus, projectSummary, probeProject, deleteProject, projectDir } from './projects.js';
import { ytdlpDownload } from '../lib/ytdlp.js';
import { transcribeProject, loadTranscript, formatTranscriptForPrompt } from './transcribe.js';
import { analyzeContent, generateCandidates, resolveCandidate, scoreCandidate, deduplicate, combineScores } from './analysis.js';
import { optimizeBoundary, refineBoundaryWithAI } from './boundary.js';
import {
  createClip, replaceProjectClips, selectClips, listClips, updateClip, getClip,
} from './clips.js';
import { renderClip } from './render.js';
import { resolveRenderOptions, saveRenderSnapshot } from './render-options.js';
import { getOrCreateEditingPlan } from './editing-plan.js';
import { aiEmphasisWords } from './subtitles.js';
import { probeVideo } from '../lib/ffmpeg.js';

/**
 * The render pipeline stage orchestrator.
 *
 * enqueueProjectPipeline(seed) -> TRANSCRIBE -> ANALYZE -> FIND_CLIPS
 *   -> SCORE -> READY
 *
 * Each stage is registered as a separate job handler. render_preview and
 * render_final deliberately bypass the chain (on-demand).
 */

export function enqueueProjectPipeline(projectId: string): void {
  enqueue('transcription', { project_id: projectId });
}

export function enqueueRender(
  clipId: string,
  kind: 'preview' | 'final' | 'telegram',
  renderOpts?: { options?: unknown; preset?: string | null }
): void {
  const clip = getClip(clipId);
  if (!clip) throw new Error(`clip ${clipId} not found`);
  if (renderOpts?.options !== undefined) resolveRenderOptions(renderOpts.options, renderOpts.preset ?? null); // fail fast on bad input
  const active = q.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE clip_id = ? AND type IN ('render_preview','render_final') AND status IN ('queued','running')",
    clipId
  );
  if ((active?.n ?? 0) > 0) throw new Error('a render is already queued or running for this clip');
  setProjectStatusSafe(clip.project_id, 'RENDERING');
  const type: JobType = kind === 'preview' ? 'render_preview' : kind === 'telegram' ? 'render_final' : 'render_final';
  enqueue(type, { project_id: clip.project_id, clip_id: clipId, payload: { kind, options: renderOpts?.options ?? null, preset: renderOpts?.preset ?? null } });
}

function setProjectStatusSafe(id: string, status: Parameters<typeof setProjectStatus>[1]) {
  try { setProjectStatus(id, status); } catch { /* may already be deleted */ }
}

function getProjectFor(job: { project_id: string | null }) {
  const p = getProject(job.project_id!);
  if (!p) throw new Error(`project ${job.project_id} not found`);
  return p;
}

export function registerPipelineJobs(): void {
  registerHandler('download', async (job, ctx) => {
    const p = getProjectFor(job);
    const { url } = JSON.parse(job.payload || '{}') as { url: string };
    try {
      const { file } = await ytdlpDownload(url, projectDir(p.id), (line) => {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) ctx.report(parseFloat(m[1]));
      });
      q.run("UPDATE projects SET source_path = ?, updated_at = datetime('now') WHERE id = ?", file, p.id);
      const meta = await probeProject(p.id);
      if (!meta.hasVideo) throw new Error('downloaded file has no video stream');
      logger.info('VIDEO', `url project ready: ${p.id} (${meta.duration.toFixed(1)}s ${meta.width}x${meta.height})`);
      enqueueProjectPipeline(p.id);
    } catch (e) {
      deleteProject(p.id);
      throw e;
    }
  });

  registerHandler('probe', async (job, ctx) => {
    const p = getProjectFor(job);
    const meta = await probeVideo(p.source_path);
    q.run("UPDATE projects SET meta = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(meta), p.id);
    ctx.report(100);
  });

  registerHandler('transcription', async (job, ctx) => {
    const p = getProjectFor(job);
    setProjectStatus(p.id, 'TRANSCRIBING');
    const payload = JSON.parse(job.payload || '{}');
    const meta = payload.meta ?? (await probeVideo(p.source_path));
    q.run("UPDATE projects SET meta = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(meta), p.id);
    const data = await transcribeProject(p.id, p.source_path, meta, (x) => ctx.report(x * 0.9 + 5));
    logger.info('TRANSCRIPTION', `project ${p.id}: ${data.segments.length} segments, ${data.duration.toFixed(1)}s`);
    setProjectStatus(p.id, 'ANALYZING');
    enqueue('analysis', { project_id: p.id });
  });

  registerHandler('analysis', async (job, ctx) => {
    const p = getProjectFor(job);
    setProjectStatus(p.id, 'ANALYZING');
    const transcript = loadTranscript(p.id);
    if (!transcript) throw new Error('transcript missing; rerun transcription first');
    ctx.report(20);
    const moments = await analyzeContent(p.id, transcript);
    q.run('DELETE FROM analyses WHERE project_id = ? AND type = ?', p.id, 'moments');
    q.run('INSERT INTO analyses (project_id, type, data) VALUES (?,?,?)', p.id, 'moments', JSON.stringify(moments));
    ctx.report(100);
    setProjectStatus(p.id, 'FINDING_CLIPS');
    enqueue('candidate_generation', { project_id: p.id });
  });

  registerHandler('candidate_generation', async (job, ctx) => {
    const p = getProjectFor(job);
    setProjectStatus(p.id, 'FINDING_CLIPS');
    const transcript = loadTranscript(p.id);
    if (!transcript) throw new Error('transcript missing');
    const stored = JSON.parse(q.get<{ data: string }>(
      "SELECT data FROM analyses WHERE project_id = ? AND type = 'moments' ORDER BY id DESC LIMIT 1", p.id
    )?.data ?? '[]');
    const moments = Array.isArray(stored) ? stored : (stored?.moments ?? []);
    ctx.report(30);
    const candidates = await generateCandidates(p.id, transcript, moments);
    if (!candidates.length) {
      logger.warn('VIDEO', `no candidates generated for ${p.id}`);
      setProjectStatus(p.id, 'FAILED', 'no viable clip candidates found');
      return;
    }
    q.run("DELETE FROM analyses WHERE project_id = ? AND type = 'candidates'", p.id);
    for (const c of candidates) {
      const t = resolveCandidate(c, transcript.segments);
      q.run(
        'INSERT INTO analyses (project_id, type, data) VALUES (?,?,?)',
        p.id, 'candidates', JSON.stringify({
          start_segment: c.start_segment, end_segment: c.end_segment,
          start: t.start, end: t.end, duration: t.duration,
          title: c.title, hook: c.hook, reason: c.reason,
        })
      );
    }
    ctx.report(100);
    setProjectStatus(p.id, 'SCORING');
    enqueue('scoring', { project_id: p.id });
  });
}

export function registerScoringJob(): void {
  registerHandler('scoring', async (job, ctx) => {
    const p = getProjectFor(job);
    setProjectStatus(p.id, 'SCORING');
    const transcript = loadTranscript(p.id);
    if (!transcript) throw new Error('transcript missing');
    const candRows = (q.all<{ data: string }>(
      "SELECT data FROM analyses WHERE project_id = ? AND type = 'candidates' ORDER BY id DESC", p.id
    ) ?? []).map((r) => JSON.parse(r.data));
    if (!candRows.length) throw new Error('no candidates to score');

    const scored = [];
    for (let i = 0; i < candRows.length; i++) {
      const c = candRows[i];
      const clipWindow = { start: c.start, end: c.end, title: c.title, duration: c.duration };
      const score = await scoreCandidate(transcript, clipWindow);
      const boundary = await optimizeBoundary(transcript, c.start, c.end);
      const refined = await refineBoundaryWithAI(transcript, boundary.start, boundary.end);
      const finalStart = refined.start;
      const finalEnd = refined.end;
      const duration = refined.end - refined.start;
      const withLen = combineScores({ ...score.scores }, duration);
      scored.push({
        start_segment: c.start_segment, end_segment: c.end_segment,
        start: finalStart, end: finalEnd, duration,
        title: c.title, hook: c.hook, reason: c.reason,
        scores: withLen.scores, reason_comment: score.comment,
        overall: withLen.overall_score,
        boundary: { start: boundary.start, end: boundary.end, refined, note: refined.note, snap: 'ai' },
      });
      ctx.report(10 + Math.round(((i + 1) / candRows.length) * 90));
    }

    // greedy dedup on final refined boundaries: strongest overall first,
    // drop any candidate overlapping a kept one beyond the threshold
    const thr = getSettings('clipping').overlap_threshold;
    scored.sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
    const kept: typeof scored = [];
    for (const c of scored) {
      const dur = c.end - c.start;
      const clash = kept.some((k) =>
        Math.max(0, Math.min(k.end, c.end) - Math.max(k.start, c.start)) / Math.min(k.end - k.start, dur) >= thr
      );
      if (!clash) kept.push(c);
    }

    const clips = replaceProjectClips(p.id, kept);
    const top = selectClips(p.id, { top: getSettings('clipping').top_clips, ids: clips.map((c) => c.id) });
    setProjectStatus(p.id, 'READY', null);
    logger.info('VIDEO', `project ${p.id} ready with ${clips.length} clips, selected ${top.length}`);
  });
}

/* ---------------- render jobs ---------------- */

export function registerRenderJobs(): void {
  registerHandler('render_preview', async (job, ctx) => {
    await doRender(job, 'preview', ctx);
  });
  registerHandler('render_final', async (job, ctx) => {
    const payload = JSON.parse(job.payload || '{}') as { kind?: string };
    await doRender(job, payload.kind === 'telegram' ? 'telegram' : 'final', ctx);
  });
}

async function doRender(job: { id: string; project_id: string | null; clip_id: string | null; payload: string | null }, kind: 'preview' | 'final' | 'telegram', ctx: { report: (p: number) => void }) {
  const p = getProjectFor({ project_id: job.project_id! });
  const clip = getClip(job.clip_id!);
  if (!clip) throw new Error(`clip ${job.clip_id} not found`);
  if (kind === 'final') setProjectStatus(p.id, 'RENDERING');
  try {
    const transcript = loadTranscript(p.id);
    const meta = JSON.parse(p.meta || '{}') ?? {};
    const payload = JSON.parse(job.payload || '{}') as { options?: unknown; preset?: string | null };
    // Resolve options only when the job actually starts, then freeze them:
    // settings changed while the job sat in the queue do not leak in.
    const { options } = resolveRenderOptions(payload.options ?? null, payload.preset ?? null);
    saveRenderSnapshot(job.id, clip.id, options);
    // Clip windows can extend past the source (AI boundary refine); clamp so
    // the QA duration check compares against what is actually renderable.
    const srcDur = Number(meta.duration) || 0;
    const start = Math.max(0, srcDur ? Math.min(clip.start, srcDur - 1) : clip.start);
    const end = srcDur ? Math.min(clip.end, srcDur) : clip.end;
    const plan = await getOrCreateEditingPlan({
      clipId: clip.id,
      clipStart: start,
      clipEnd: end,
      title: clip.title ?? null,
      transcript: transcript ?? null,
      options,
      aspect: (options.aspect ?? clip.aspect ?? getSettings('reframe').aspect) as '9:16' | '1:1' | '16:9',
      sourcePath: p.source_path,
      probe: meta,
    });
    await renderClip({
      clip: { id: clip.id, start, end, aspect: clip.aspect, subtitle_preset: clip.subtitle_preset, title: clip.title ?? null },
      sourcePath: p.source_path,
      probe: meta,
      kind,
      transcript: transcript?.segments ?? null,
      options,
      plan,
      jobId: job.id,
      onProgress: (pct) => ctx.report(pct),
    });
    updateClip(clip.id, {
      status: kind === 'final' ? 'rendered_final' : 'previewed',
    });
  } finally {
    // Clear RENDERING on success AND failure — otherwise the project polls forever.
    const other = q.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND type IN ('render_preview','render_final') AND id != ?", job.id
    );
    if (!other?.n && getProject(p.id)?.status === 'RENDERING') setProjectStatusSafe(p.id, 'READY');
  }
}

/** Wrap a job payload's probe so downstream stages don't re-probe. */
export function withProbe(payload: Record<string, unknown>, probe: unknown): Record<string, unknown> {
  return { ...payload, meta: probe };
}

export { projectSummary };
