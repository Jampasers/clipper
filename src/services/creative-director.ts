import { generate } from '../lib/ai.js';
import { logger } from '../lib/log.js';
import {
  BROLL_SCHEMA,
  CALLOUT_SCHEMA,
  EDL_MUSIC_SCHEMA,
  EDL_STYLE_SCHEMA,
  EMPHASIS_SCHEMA,
  FRAMING_SCHEMA,
  GRADE_NAMES,
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
  type Framing,
  type GradeName,
  type ShotSize,
  type TransitionType,
} from './edl.js';
import { chooseStyle, speechRate } from './adaptive-style.js';
import { listBroll } from './broll.js';
import { listSfx } from './sfx.js';
import { compactLearningContext, contextSummary, type VisualLearningContext } from './reference-retrieval.js';
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
 * the deterministic baseline â€” this function never throws.
 */

const CREATIVE_SYSTEM =
  'You are a video creative director. You edit a JSON creative plan (EDL). Respond with JSON data only â€” no prose, no code, no shell commands.';

const LEARNING_RULES = `VISUAL LEARNING CONTEXT (advisory â€” reference styles are INSPIRATION, never templates to copy):
{{learning}}

Rules for using it:
- Adapt reference styles to the ACTUAL footage; never force effects a scene does not support.
- Obey the "constraints" limits exactly (maxFramings/maxBroll/maxSfx/maxGraphics/maxEmphasis).
- Learned preferences are the user's taste: follow them unless the scene clearly contradicts them.
- Avoid repetitive zooms; do not stack effects; preserve speech clarity, faces and subtitle readability.
- Prefer intentional editing over random effects; keep the narrative flow.`;

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
  /** validated visual learning context (references + preferences + constraints) */
  learning?: VisualLearningContext | null;
}

export interface CreativeProvenance {
  contextKey: string;
  referenceIds: string[];
  referenceScores: Record<string, number>;
  preferenceApplications: string[];
  constraintApplications: string[];
  notes: string[];
  insights: string[];
  sources: Record<string, string>;
}

export interface CreativeDirectResult {
  edl: Edl;
  source: 'ai' | 'fallback';
  model: string;
  provenance: CreativeProvenance | null;
}

function emptyProvenance(learning: VisualLearningContext | null | undefined): CreativeProvenance | null {
  if (!learning) return null;
  return {
    contextKey: learning.contextKey,
    referenceIds: learning.references.map((r) => r.id),
    referenceScores: Object.fromEntries(learning.references.map((r) => [r.id, r.score])),
    preferenceApplications: [],
    constraintApplications: [],
    notes: [...learning.notes],
    insights: [...learning.insights],
    sources: {},
  };
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
  const provenance = emptyProvenance(input.learning);
  if (provenance) {
    provenance.sources.references = input.learning?.references.length ? 'reference_context_injected' : 'none';
    provenance.sources.base_plan = 'deterministic_fallback_baseline';
  }

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

  let system = CREATIVE_SYSTEM;
  if (input.learning) {
    const compact = compactLearningContext(input.learning);
    system = `${CREATIVE_SYSTEM}\n\n${LEARNING_RULES.replace('{{learning}}', JSON.stringify(compact))}`;
    logger.debug('AI', `creative direction learning: ${contextSummary(input.learning)}`);
  }

  let fragment: unknown;
  let model = 'fallback';
  try {
    const res = await generate<unknown>('creative_direction', vars, system);
    fragment = res.json;
    model = res.model;
  } catch (err) {
    logger.warn('AI', `creative direction failed (${String((err as Error)?.message).slice(0, 160)}); using deterministic EDL`);
    const fallback = validateEdl(baseline.edl, ctx);
    const constrained = applyLearningConstraints(fallback.edl ?? baseline.edl, input.learning, input.scene, { sfxIds: sfxLib.map((s) => s.id) });
    const checked = validateEdl(constrained.edl, ctx);
    if (provenance) provenance.sources.base_plan = 'deterministic_fallback';
    return { edl: checked.edl ?? constrained.edl, source: 'fallback', model, provenance: provenance ? certify(provenance, constrained.provenance) : null };
  }

  const notes: string[] = [];
  const merged = mergeFragment(baseline.edl, fragment, notes);
  const result = validateEdl(merged, ctx);
  if (!result.ok || !result.edl) {
    logger.warn('AI', `creative direction EDL rejected (${result.errors[0] ?? 'unknown'}); using deterministic EDL`);
    const fallback = validateEdl(baseline.edl, ctx);
    const constrained = applyLearningConstraints(fallback.edl ?? baseline.edl, input.learning, input.scene, { sfxIds: sfxLib.map((s) => s.id) });
    const checked = validateEdl(constrained.edl, ctx);
    if (provenance) provenance.sources.base_plan = 'deterministic_fallback';
    return { edl: checked.edl ?? constrained.edl, source: 'fallback', model, provenance: provenance ? certify(provenance, constrained.provenance) : null };
  }
  if (notes.length) for (const n of notes) logger.debug('AI', `creative direction: ${n}`);
  logEdlWarnings('creative_direction', result);
  if (provenance) provenance.sources.base_plan = 'ai';

  // Deterministic, bounded application of learned preferences (never trust the
  // model to enforce taste on its own).
  const constrained = applyLearningConstraints(result.edl, input.learning, input.scene, { sfxIds: sfxLib.map((s) => s.id) });
  const checked = validateEdl(constrained.edl, ctx);
  const finalEdl = checked.ok && checked.edl ? checked.edl : result.edl;
  if (!checked.ok) {
    logger.warn('AI', `learned-preference adjustments rejected (${checked.errors[0] ?? 'unknown'}); using validated AI EDL`);
  }
  return { edl: finalEdl, source: 'ai', model, provenance: provenance ? certify(provenance, constrained.provenance) : null };
}

function certify(base: CreativeProvenance, applied: CreativeProvenance | null): CreativeProvenance {
  if (!applied) return base;
  base.preferenceApplications = applied.preferenceApplications;
  base.constraintApplications = applied.constraintApplications;
  base.notes = Array.from(new Set([...base.notes, ...applied.notes]));
  base.sources = { ...base.sources, ...applied.sources };
  return base;
}

/* ---------------- deterministic learned-preference application ---------------- */

const GRADE_PREF_MAP: Record<string, GradeName> = {
  none: 'none',
  neutral: 'none',
  warm: 'warm',
  high_contrast_warm: 'warm',
  cool: 'cool',
  high_contrast_cool: 'cool',
  vivid: 'vivid',
  cinematic: 'cinematic',
  desaturated: 'cinematic',
};

const SHOT_ORDER: ShotSize[] = ['wide', 'medium', 'close'];

function pickEven<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  const out: T[] = [];
  const step = (items.length - 1) / Math.max(1, count - 1);
  for (let i = 0; i < count; i++) out.push(items[Math.round(i * step)]);
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Split the longest framings until the target count is reached (punch-in rhythm). */
function padFramings(framings: Framing[], target: number, maxLen = 6): Framing[] {
  const out = framings.map((f) => ({ ...f }));
  let guard = 0;
  while (out.length < Math.min(target, maxLen) && guard++ < 20) {
    let idx = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i].end - out[i].start > out[idx].end - out[idx].start) idx = i;
    }
    const f = out[idx];
    if (f.end - f.start < 3) break; // keep every shot >= 1.5s
    const mid = round3((f.start + f.end) / 2);
    const shot: ShotSize = f.shot === 'close' ? 'medium' : 'close';
    const a: Framing = { ...f, end: mid };
    const b: Framing = { ...f, start: mid, shot, ease: Math.min(2, f.ease + 0.2) };
    out.splice(idx, 1, a, b);
  }
  return out;
}

/**
 * Apply validated learned preferences + reference-consensus targets onto an EDL.
 * Reduces (caps) or pads toward an explicit target face-aware (speaker focus), and
 * only ever inserts schema-valid items that survive validateEdl. Every change is
 * recorded in the provenance so the dashboard can explain "why".
 */
export function applyLearningConstraints(
  edl: Edl,
  learning: VisualLearningContext | null | undefined,
  scene: SceneAnalysis | null,
  opts: { sfxIds?: string[] } = {}
): { edl: Edl; provenance: CreativeProvenance | null } {
  if (!learning) return { edl, provenance: null };
  const provenance = emptyProvenance(learning)!;
  const c = learning.constraints;

  let next: Edl = {
    ...edl,
    style: { ...edl.style, transition: { ...edl.style.transition } },
    framings: edl.framings.map((f) => ({ ...f })),
    titles: [...edl.titles],
    lowerThirds: [...edl.lowerThirds],
    statCards: [...edl.statCards],
    callouts: [...edl.callouts],
    broll: [...edl.broll],
    sfx: [...edl.sfx],
    emphasis: [...edl.emphasis],
    music: edl.music ? { ...edl.music } : null,
  };

  // grade preference (scene-safe)
  if (c.preferredGrade) {
    const mapped = GRADE_PREF_MAP[c.preferredGrade];
    if (mapped && (GRADE_NAMES as readonly string[]).includes(mapped)) {
      const conflictsWithScene = (!!scene?.dark && mapped === 'cool') || (!!scene?.bright && mapped === 'warm');
      if (conflictsWithScene) {
        provenance.notes.push(`kept ${next.style.grade} grade: preferred ${mapped} conflicts with scene brightness`);
      } else if (next.style.grade !== mapped) {
        next.style = { ...next.style, grade: mapped };
        provenance.preferenceApplications.push(`grade -> ${mapped} (preference ${c.preferredGrade})`);
        provenance.sources.grade = 'preference';
      }
    }
  }

  // transition preference
  if (c.preferredTransition && ['cut', 'fade', 'slide'].includes(c.preferredTransition)) {
    const t = c.preferredTransition as TransitionType;
    if (next.style.transition.type !== t) {
      next.style = { ...next.style, transition: { ...next.style.transition, type: t } };
      provenance.preferenceApplications.push(`transition -> ${t}`);
      provenance.sources.transition = 'preference';
    }
  }

  // zoom / framing caps
  if (c.maxFramings !== null && next.framings.length > c.maxFramings) {
    const before = next.framings.length;
    next.framings = pickEven(next.framings, c.maxFramings);
    provenance.constraintApplications.push(`framings ${before} -> ${next.framings.length} (zoom preference)`);
    provenance.sources.framings = 'preference';
  }
  if (c.shotCeiling) {
    const ceil = SHOT_ORDER.indexOf(c.shotCeiling);
    let changed = 0;
    next.framings = next.framings.map((f) => {
      const idx = SHOT_ORDER.indexOf(f.shot);
      if (idx > ceil) {
        changed++;
        return { ...f, shot: c.shotCeiling as ShotSize };
      }
      return f;
    });
    if (changed) provenance.preferenceApplications.push(`clamped ${changed} framing(s) to ${c.shotCeiling} (zoom intensity preference)`);
  }
  // zoom target floor (reference/learned taste wants punchier pacing)
  if (c.minFramings !== null && next.framings.length < c.minFramings) {
    const before = next.framings.length;
    next.framings = padFramings(next.framings, c.minFramings);
    if (next.framings.length > before) {
      provenance.constraintApplications.push(`framings ${before} -> ${next.framings.length} (zoom target)`);
      provenance.sources.framings = 'preference';
    }
  }

  // b-roll cap
  if (c.maxBroll !== null && next.broll.length > c.maxBroll) {
    const before = next.broll.length;
    next.broll = next.broll.slice(0, c.maxBroll);
    provenance.constraintApplications.push(`b-roll ${before} -> ${next.broll.length} (b-roll density preference)`);
    provenance.sources.broll = 'preference';
  }

  // sfx cap
  if (c.maxSfx !== null && next.sfx.length > c.maxSfx) {
    const before = next.sfx.length;
    next.sfx = next.sfx.slice(0, c.maxSfx);
    provenance.constraintApplications.push(`sfx ${before} -> ${next.sfx.length} (sfx density preference)`);
    provenance.sources.sfx = 'preference';
  }
  // sfx baseline at cut points when the mix is too dry for the target density
  if (c.sfxBaseline !== null && opts.sfxIds?.length && next.sfx.length < c.sfxBaseline) {
    const cuts = next.framings.slice(1).map((f) => f.start).filter((t) => t > 0.3);
    const picks = pickEven(cuts, c.sfxBaseline - next.sfx.length);
    picks.forEach((at, i) => {
      next.sfx.push({ libraryId: opts.sfxIds![i % opts.sfxIds!.length], at: round3(at), volumeDb: -6 });
    });
    if (picks.length) {
      provenance.constraintApplications.push(`sfx +${picks.length} at cuts (sfx density target)`);
      provenance.sources.sfx = 'preference';
    }
  }

  // graphics cap (drop the lowest-priority kinds first)
  if (c.maxGraphics !== null) {
    const total = next.titles.length + next.lowerThirds.length + next.statCards.length + next.callouts.length;
    if (total > c.maxGraphics) {
      let excess = total - c.maxGraphics;
      const shrink = <T,>(arr: T[]): T[] => {
        if (!arr.length || excess <= 0) return arr;
        const n = Math.min(excess, arr.length);
        excess -= n;
        return arr.slice(0, arr.length - n);
      };
      next.statCards = shrink(next.statCards);
      next.lowerThirds = shrink(next.lowerThirds);
      next.callouts = shrink(next.callouts);
      next.titles = shrink(next.titles);
      provenance.constraintApplications.push(`graphics ${total} -> ${next.titles.length + next.lowerThirds.length + next.statCards.length + next.callouts.length} (visual complexity preference)`);
      provenance.sources.graphics = 'preference';
    }
  }

  // text/graphic placement target (top/center/bottom)
  if (c.titlePosition) {
    let changed = 0;
    next.titles = next.titles.map((t) => {
      if (t.position === c.titlePosition) return t;
      changed++;
      return { ...t, position: c.titlePosition! };
    });
    if (changed) {
      provenance.preferenceApplications.push(`titles moved to ${c.titlePosition} (text placement target)`);
      provenance.sources.graphics = 'preference';
    }
  }

  // emphasis cap (subtitle density)
  if (c.maxEmphasis !== null && next.emphasis.length > c.maxEmphasis) {
    next.emphasis = next.emphasis.slice(0, c.maxEmphasis);
    provenance.constraintApplications.push(`emphasis words capped at ${c.maxEmphasis} (subtitle density preference)`);
    provenance.sources.emphasis = 'preference';
  }

  // music intensity
  if (c.musicIntensity && next.music) {
    if (c.musicIntensity === 'none' || c.musicIntensity === 'very_low') {
      next.music = { ...next.music, enabled: false };
      provenance.preferenceApplications.push('background music disabled (music intensity preference)');
    } else if (c.musicIntensity === 'low') {
      next.music = { ...next.music, volumeDb: Math.max(-40, next.music.volumeDb - 6) };
      provenance.preferenceApplications.push('background music lowered 6 dB (music intensity preference)');
    } else if (c.musicIntensity === 'high' || c.musicIntensity === 'very_high') {
      next.music = { ...next.music, volumeDb: Math.min(6, next.music.volumeDb + 3) };
      provenance.preferenceApplications.push('background music raised 3 dB (music intensity preference)');
    }
    provenance.sources.music = 'preference';
  }

  if (c.preferredSubtitleStyle) {
    provenance.notes.push(`subtitle style hint: ${c.preferredSubtitleStyle} (applied at render time when the user left the style on auto)`);
  }
  if (c.pacingHint) {
    provenance.notes.push(`pacing hint: ${c.pacingHint}`);
  }

  return { edl: next, provenance };
}
