import crypto from 'node:crypto';
import { q, J } from '../lib/sqlite.js';
import { logger } from '../lib/log.js';
import { planOptionsHash, type RenderOptions } from './render-options.js';
import { buildTimeline, type TimelinePlan, type HookSpan } from './timeline.js';
import { generateHookPlan, type HookPlan } from './hook.js';
import { generateSubtitlePlan, collectClipWords, type SubtitleEditingPlan } from './subtitle-plan.js';
import { selectMusic, type MusicPlan } from './music.js';
import { analyzeScene, type SceneAnalysis } from './scene-analysis.js';
import { directCreative } from './creative-director.js';
import type { Edl } from './edl.js';
import type { TranscriptData } from './transcribe.js';

/**
 * One editing plan per (clip, options-hash): hook choice, output timeline,
 * AI subtitle styling, music selection and — in adaptive mode — the Creative
 * Director EDL (framings, graphics, b-roll, sfx, grade). Cached in editing_plans
 * so a re-render with identical options reuses the same creative decisions —
 * no AI call, no drift.
 */

export const PLAN_VERSION = 4;

export interface EditingPlan {
  version: typeof PLAN_VERSION;
  clipId: string;
  clipStart: number;
  clipEnd: number;
  optionsHash: string;
  timeline: TimelinePlan;
  hook: HookPlan | null;
  subtitle: SubtitleEditingPlan | null;
  music: MusicPlan | null;
  /** adaptive-mode creative plan; null in basic mode or when disabled/failed */
  creative: Edl | null;
  creativeSource: 'ai' | 'fallback' | null;
  creativeModel: string | null;
  model: string;
  createdAt: string;
}

export interface PlanInput {
  clipId: string;
  clipStart: number;
  clipEnd: number;
  title: string | null;
  transcript: TranscriptData | null;
  options: RenderOptions;
  /** resolved output aspect (render options > clip > settings) */
  aspect?: '9:16' | '1:1' | '16:9';
  /** source media, used by scene analysis for the adaptive plan */
  sourcePath?: string | null;
  probe?: { width?: number; height?: number; duration?: number } | null;
}

/** Cheap fingerprint of the transcript so stale plans are rebuilt after re-transcription. */
export function transcriptFingerprint(transcript: TranscriptData | null): string {
  if (!transcript?.segments?.length) return 'none';
  const segs = transcript.segments;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  return crypto
    .createHash('sha1')
    .update(`${segs.length}|${first.start.toFixed(2)}|${last.end.toFixed(2)}|${chars}|${transcript.model ?? ''}`)
    .digest('hex')
    .slice(0, 12);
}

export function planHashFor(input: PlanInput): string {
  return planOptionsHash(input.options, {
    start: Math.round(input.clipStart * 100) / 100,
    end: Math.round(input.clipEnd * 100) / 100,
    tr: transcriptFingerprint(input.transcript),
  });
}

export function getCachedPlan(clipId: string, optionsHash: string): EditingPlan | null {
  const row = q.get<{ data: string }>('SELECT data FROM editing_plans WHERE clip_id = ? AND options_hash = ?', clipId, optionsHash);
  return (row ? J.read<EditingPlan>(row.data) : null) ?? null;
}

/** Build the full plan (AI calls happen here) and persist it. */
export async function buildEditingPlan(input: PlanInput): Promise<EditingPlan> {
  const hash = planHashFor(input);
  const { options, transcript } = input;

  let hook: HookPlan | null = null;
  if (options.hook.enabled && transcript) {
    const outcome = await generateHookPlan(transcript, input.clipStart, input.clipEnd, {
      target: options.hook.duration,
      allowFallback: options.hook.allowFallback,
    });
    hook = outcome.plan;
  }
  const hookSpan: HookSpan | null = hook ? { start: hook.start, end: hook.end } : null;
  const timeline = buildTimeline(input.clipStart, input.clipEnd, hookSpan);

  let subtitle: SubtitleEditingPlan | null = null;
  if (options.subtitles.enabled && transcript) {
    subtitle = await generateSubtitlePlanFor(input, transcript);
  }

  let music: MusicPlan | null = null;
  if (options.backgroundMusic.enabled) {
    music = await selectMusic(transcript, input.clipStart, input.clipEnd, input.title, options.backgroundMusic.selection);
  }

  let creative: Edl | null = null;
  let creativeSource: 'ai' | 'fallback' | null = null;
  let creativeModel: string | null = null;
  if (options.creative?.mode === 'adaptive') {
    const c = await buildCreativePlan(input, timeline, hook, subtitle, music);
    creative = c?.edl ?? null;
    creativeSource = c?.source ?? null;
    creativeModel = c?.model ?? null;
  }

  const plan: EditingPlan = {
    version: PLAN_VERSION,
    clipId: input.clipId,
    clipStart: input.clipStart,
    clipEnd: input.clipEnd,
    optionsHash: hash,
    timeline,
    hook,
    subtitle,
    music,
    creative,
    creativeSource,
    creativeModel,
    model: subtitle?.model ?? '',
    createdAt: new Date().toISOString(),
  };
  try {
    q.run(
      `INSERT INTO editing_plans (clip_id, version, options_hash, data, model) VALUES (?,?,?,?,?)
       ON CONFLICT(clip_id, options_hash) DO UPDATE SET data = excluded.data, version = excluded.version`,
      input.clipId,
      PLAN_VERSION,
      hash,
      JSON.stringify(plan),
      plan.model
    );
  } catch (err: any) {
    logger.warn('AI', `could not cache editing plan for ${input.clipId}: ${String(err?.message).slice(0, 160)}`);
  }
  return plan;
}

/** Cache-first plan resolution. A cached plan is only reused for the same clip window + transcript. */
export async function getOrCreateEditingPlan(input: PlanInput): Promise<EditingPlan> {
  const hash = planHashFor(input);
  const cached = getCachedPlan(input.clipId, hash);
  if (
    cached?.version === PLAN_VERSION &&
    Math.abs(cached.clipStart - input.clipStart) < 0.01 &&
    Math.abs(cached.clipEnd - input.clipEnd) < 0.01
  ) {
    logger.debug('AI', `editing plan cache hit for ${input.clipId} (${hash})`);
    return cached;
  }
  return buildEditingPlan(input);
}

function generateSubtitlePlanFor(input: PlanInput, transcript: TranscriptData): Promise<SubtitleEditingPlan> {
  const words = collectClipWords(transcript.segments, input.clipStart, input.clipEnd);
  return generateSubtitlePlan(words);
}

/**
 * Adaptive creative plan: local scene analysis + Creative Director over the
 * deterministic baseline. Never throws — a failed AI call or analyzer just
 * yields the baseline EDL (or null when there is nothing to work with).
 */
async function buildCreativePlan(
  input: PlanInput,
  timeline: TimelinePlan,
  hook: HookPlan | null,
  subtitle: SubtitleEditingPlan | null,
  music: MusicPlan | null
): Promise<{ edl: Edl; source: 'ai' | 'fallback'; model: string } | null> {
  try {
    const transcript = input.transcript;
    const aspect = input.aspect ?? input.options.aspect ?? '9:16';
    const words = transcript ? collectClipWords(transcript.segments, input.clipStart, input.clipEnd) : null;
    let scene: SceneAnalysis | null = null;
    if (input.sourcePath && input.probe?.width && input.probe?.height) {
      const speech = (transcript?.segments ?? [])
        .filter((s) => s.end > input.clipStart && s.start < input.clipEnd)
        .map((s) => ({ start: Math.max(s.start, input.clipStart), end: Math.min(s.end, input.clipEnd) }));
      scene = await analyzeScene({
        sourcePath: input.sourcePath,
        windowStart: input.clipStart,
        windowEnd: input.clipEnd,
        speech,
        sourceDuration: input.probe.duration,
      });
    }
    const hookSeg = timeline.segments.find((s) => s.role === 'hook');
    const hookEndOut = hook && hookSeg ? hookSeg.outputEnd : null;
    const { edl, source, model } = await directCreative({
      title: input.title,
      clipStart: input.clipStart,
      clipEnd: input.clipEnd,
      duration: timeline.outputDuration,
      aspect,
      sourceAspect: input.probe?.width && input.probe?.height ? input.probe.width / input.probe.height : 0,
      scene,
      hasHook: !!hook,
      timeline,
      transcript: transcript?.segments ?? null,
      words,
      subtitlePlan: subtitle?.words ?? null,
      musicPlan: music,
    hookText: hook?.text ?? null,
    hookEnd: hookEndOut,
    });
    logger.info(
      'AI',
      `creative plan ${input.clipId}: source=${source} model=${model} grade=${edl.style.grade} ` +
        `zoom=${edl.style.punchIn} titles=${edl.titles.length} lower=${edl.lowerThirds.length} stats=${edl.statCards.length} ` +
        `callouts=${edl.callouts.length} broll=${edl.broll.length} sfx=${edl.sfx.length}`
    );
    return { edl, source, model };
  } catch (err: any) {
    logger.warn('AI', `creative plan failed for ${input.clipId} (continuing with basic chrome): ${String(err?.message).slice(0, 200)}`);
    return null;
  }
}

/** List stored plans for a clip (newest first) — for the dashboard "why did it render like this". */
export function listEditingPlans(clipId: string, limit = 20) {
  return q
    .all<{ id: number; options_hash: string; model: string | null; data: string; created_at: string }>(
      'SELECT id, options_hash, model, data, created_at FROM editing_plans WHERE clip_id = ? ORDER BY id DESC LIMIT ?',
      clipId,
      limit
    )
    .map((r) => ({ id: r.id, options_hash: r.options_hash, model: r.model, created_at: r.created_at, plan: J.read<EditingPlan>(r.data) }));
}
