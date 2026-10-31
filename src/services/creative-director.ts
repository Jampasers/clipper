import { generate } from '../lib/ai.js';
import { logger } from '../lib/log.js';
import {
  BROLL_SCHEMA,
  CALLOUT_SCHEMA,
  EDL_MUSIC_SCHEMA,
  EDL_STYLE_SCHEMA,
  EMPHASIS_SCHEMA,
  FRAMING_SCHEMA,
  LOWER_THIRD_SCHEMA,
  SFX_SCHEMA,
  STAT_CARD_SCHEMA,
  TITLE_SCHEMA,
  buildFallbackEdl,
  logEdlWarnings,
  validateEdl,
  type Edl,
  type EdlContext,
  type EdlMusic,
} from './edl.js';
import { chooseStyle, speechRate } from './adaptive-style.js';
import { listBroll } from './broll.js';
import { listSfx } from './sfx.js';
import type { ClipWord, PlannedWordStyle } from './subtitle-plan.js';
import type { MusicPlan } from './music.js';
import type { TranscriptSegment } from './transcribe.js';
import { mapSourceToOutput, type TimelinePlan } from './timeline.js';
import type { SceneAnalysis } from './scene-analysis.js';

/**
 * Creative Director: turns local analysis (scene, transcript, subtitle plan,
 * music plan) plus a deterministic baseline EDL into the final creative plan.
 *
 * The model only ever edits DATA (the EDL). Every value it sends is re-parsed
 * item-by-item against the zod schemas in edl.ts and then run through
 * validateEdl (clamping, dedupe, library checks). The model can never inject
 * paths, commands or styles outside the schema, and any failure degrades to
 * the deterministic baseline — this function never throws.
 */

const CREATIVE_SYSTEM =
  'You are a video creative director. You edit a JSON creative plan (EDL). Respond with JSON data only — no prose, no code, no shell commands.';

export interface CreativeDirectInput {
  title: string | null;
  clipStart: number;
  clipEnd: number;
  /** output timeline duration (after the hook reorder) */
  duration: number;
  aspect: '9:16' | '16:9' | '1:1';
  /** source frame aspect (width/height), 0 when unknown */
  sourceAspect: number;
  scene: SceneAnalysis | null;
  hasHook: boolean;
  timeline: TimelinePlan;
  transcript: TranscriptSegment[] | null;
  words: ClipWord[] | null;
  subtitlePlan: PlannedWordStyle[] | null;
  musicPlan: MusicPlan | null;
  hookText?: string | null;
  hookEnd?: number | null;
}

export interface CreativeDirectResult {
  edl: Edl;
  source: 'ai' | 'fallback';
  model: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatOutputTranscript(input: CreativeDirectInput): string {
  const lines: string[] = [];
  for (const seg of input.transcript ?? []) {
    if (seg.end <= input.clipStart || seg.start >= input.clipEnd) continue;
    const s = mapSourceToOutput(input.timeline, Math.max(seg.start, input.clipStart));
    const e = mapSourceToOutput(input.timeline, Math.min(seg.end, input.clipEnd));
    if (s === null || e === null) continue;
    const [a, b] = s <= e ? [s, e] : [Math.min(s, e), Math.min(input.duration, Math.min(s, e) + Math.min(4, seg.end - seg.start))];
    lines.push(`[${a.toFixed(1)}-${b.toFixed(1)}s] ${seg.text.trim()}`);
    if (lines.length >= 80) break;
  }
  return lines.join('\n') || '(no transcript)';
}

/** Item-by-item sanitizer: one bad AI item can't take down the whole plan. */
function sanitizeArray<T>(raw: unknown, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, cap: number, label: string, notes: string[]): T[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    notes.push(`${label}: expected an array, ignored`);
    return null;
  }
  const out: T[] = [];
  let dropped = 0;
  for (const item of raw.slice(0, cap)) {
    const p = schema.safeParse(item);
    if (p.success) out.push(p.data as T);
    else dropped++;
  }
  if (dropped > 0) notes.push(`${label}: dropped ${dropped} invalid item(s)`);
  return out;
}

/** Merge a model fragment over the baseline EDL. Omitted fields keep baseline values. */
export function mergeFragment(base: Edl, fragment: unknown, notes: string[]): unknown {
  let f = fragment;
  if (isObj(f) && isObj(f.edl)) f = f.edl;
  if (isObj(f) && isObj(f.creative)) f = f.creative;
  if (!isObj(f)) {
    notes.push('fragment is not an object, ignored entirely');
    return base;
  }
  const candidate: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  const style = EDL_STYLE_SCHEMA.safeParse(f.style);
  if (f.style !== undefined) {
    if (style.success) candidate.style = style.data;
    else notes.push('style failed validation, keeping baseline style');
  }
  const arr = <T>(key: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, cap: number) => {
    const v = sanitizeArray<T>(f[key], schema, cap, key, notes);
    if (v !== null) candidate[key] = v;
  };
  arr('framings', FRAMING_SCHEMA, 60);
  arr('titles', TITLE_SCHEMA, 12);
  arr('lowerThirds', LOWER_THIRD_SCHEMA, 6);
  arr('statCards', STAT_CARD_SCHEMA, 10);
  arr('callouts', CALLOUT_SCHEMA, 20);
  arr('broll', BROLL_SCHEMA, 20);
  arr('sfx', SFX_SCHEMA, 12);
  arr('emphasis', EMPHASIS_SCHEMA, 40);
  if (f.music !== undefined) {
    const music = EDL_MUSIC_SCHEMA.nullable().safeParse(f.music);
    if (music.success) candidate.music = music.data;
    else notes.push('music failed validation, keeping baseline music');
  }
  if (isObj(f.audio)) {
    const cur = candidate.audio as { cleanup: boolean; ducking: boolean };
    candidate.audio = {
      cleanup: typeof f.audio.cleanup === 'boolean' ? f.audio.cleanup : cur.cleanup,
      ducking: typeof f.audio.ducking === 'boolean' ? f.audio.ducking : cur.ducking,
    };
  }
  return candidate;
}

export function creativeContext(input: CreativeDirectInput, brollIds: string[], sfxIds: string[]): EdlContext {
  return {
    duration: input.duration,
    aspectRatio: input.aspect,
    clipStart: input.clipStart,
    clipEnd: input.clipEnd,
    transcript: input.transcript,
    words: input.words,
    scene: input.scene,
    brollIds,
    sfxIds,
  };
}

function baselineMusic(plan: MusicPlan | null): EdlMusic | null {
  if (!plan) return null;
  return { enabled: true, selection: plan.assetId, volumeDb: 0, duckDb: 7, fadeIn: 0.8, fadeOut: 1.5 };
}

export function buildBaseline(input: CreativeDirectInput): { edl: Edl; style: Edl['style'] } {
  const speech = speechRate(input.words, input.clipStart, input.clipEnd);
  const style = chooseStyle({
    aspect: input.aspect,
    sourceAspect: input.sourceAspect,
    duration: input.duration,
    scene: input.scene,
    hasHook: input.hasHook,
    speechRate: speech,
    hasBrollLibrary: listBroll(true).length > 0,
  });
  const edl = buildFallbackEdl({
    aspectRatio: input.aspect,
    duration: input.duration,
    clipStart: input.clipStart,
    clipEnd: input.clipEnd,
    style,
    title: input.title,
    hookText: input.hookText ?? null,
    hookEnd: input.hookEnd ?? null,
    scene: input.scene,
    words: input.words,
    subtitlePlan: input.subtitlePlan,
    music: baselineMusic(input.musicPlan),
    transcript: input.transcript,
  });
  return { edl, style };
}

/** Never throws: any AI/schema failure returns the deterministic baseline EDL. */
export async function directCreative(input: CreativeDirectInput): Promise<CreativeDirectResult> {
  const baseline = buildBaseline(input);
  const brollLib = listBroll(true);
  const sfxLib = listSfx(true);
  const ctx = creativeContext(input, brollLib.map((b) => b.id), sfxLib.map((s) => s.id));

  const hookLen = Math.max(0, input.duration - (input.clipEnd - input.clipStart));
  const vars: Record<string, unknown> = {
    title: input.title ?? '(untitled)',
    duration: input.duration.toFixed(1),
    aspect: input.aspect,
    hook: input.hasHook ? `0-${hookLen.toFixed(1)}s opening teaser` : 'none',
    scene_summary: input.scene ? JSON.stringify(input.scene).slice(0, 1200) : 'no local analysis available',
    speech_rate: speechRate(input.words, input.clipStart, input.clipEnd).toFixed(2),
    transcript: formatOutputTranscript(input),
    baseline: JSON.stringify(baseline.edl),
    broll_library:
      brollLib.map((b) => `${b.id} | ${b.name} | ${b.tags ?? ''} | ${b.kind} | ${b.duration ?? 'image'}`).join('\n') || '(empty)',
    sfx_library: sfxLib.map((s) => `${s.id} | ${s.name} | ${s.tags ?? ''} | ${s.duration ?? '?'}s`).join('\n') || '(empty)',
  };

  let fragment: unknown;
  let model = 'fallback';
  try {
    const res = await generate<unknown>('creative_direction', vars, CREATIVE_SYSTEM);
    fragment = res.json;
    model = res.model;
  } catch (err) {
    logger.warn('AI', `creative direction failed (${String((err as Error)?.message).slice(0, 160)}); using deterministic EDL`);
    const fallback = validateEdl(baseline.edl, ctx);
    return { edl: fallback.edl ?? baseline.edl, source: 'fallback', model };
  }

  const notes: string[] = [];
  const merged = mergeFragment(baseline.edl, fragment, notes);
  const result = validateEdl(merged, ctx);
  if (!result.ok || !result.edl) {
    logger.warn('AI', `creative direction EDL rejected (${result.errors[0] ?? 'unknown'}); using deterministic EDL`);
    const fallback = validateEdl(baseline.edl, ctx);
    return { edl: fallback.edl ?? baseline.edl, source: 'fallback', model };
  }
  if (notes.length) for (const n of notes) logger.debug('AI', `creative direction: ${n}`);
  logEdlWarnings('creative_direction', result);
  return { edl: result.edl, source: 'ai', model };
}
