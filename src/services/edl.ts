import { z } from 'zod';
import { logger } from '../lib/log.js';
import type { TranscriptSegment } from './transcribe.js';
import { SUBTITLE_ROLES, type ClipWord, type PlannedWordStyle } from './subtitle-plan.js';
import type { SceneAnalysis } from './scene-analysis.js';

/**
 * EDIT DECISION LIST (EDL).
 *
 * One validated, inspectable description of every creative decision for a clip.
 * The AI may only *propose* this data (via the Creative Director); it is parsed
 * by zod, normalized and semantically validated here, then compiled by
 * deterministic builders into FFmpeg filters / Remotion props. The model can
 * never emit shell commands, file paths or executable code.
 */

export const EDL_VERSION = 1;
export const EDL_ASPECTS = ['9:16', '16:9', '1:1'] as const;
export const SHOT_SIZES = ['wide', 'medium', 'close'] as const;
export const GRADE_NAMES = ['none', 'warm', 'cool', 'vivid', 'cinematic'] as const;
export const TRANSITION_TYPES = ['fade', 'slide', 'cut'] as const;
export const BROLL_MODES = ['cover', 'pip'] as const;
export const PIP_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export const CALLOUT_POINTERS = ['arrow', 'circle', 'none'] as const;
export const GRAPHIC_POSITIONS = ['top', 'center', 'bottom'] as const;
/** Roles usable for keyword emphasis (mirrors SUBTITLE_ROLES minus 'normal'). */
export const EDL_EMPHASIS_ROLES = ['important', 'number', 'emotion', 'punchline', 'hook', 'question', 'conclusion'] as const;

export type EdlAspect = (typeof EDL_ASPECTS)[number];
export type ShotSize = (typeof SHOT_SIZES)[number];
export type GradeName = (typeof GRADE_NAMES)[number];
export type TransitionType = (typeof TRANSITION_TYPES)[number];
export type BrollMode = (typeof BROLL_MODES)[number];
export type PipPosition = (typeof PIP_POSITIONS)[number];
export type CalloutPointer = (typeof CALLOUT_POINTERS)[number];
export type GraphicPosition = (typeof GRAPHIC_POSITIONS)[number];
export type EdlEmphasisRole = (typeof EDL_EMPHASIS_ROLES)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;

const range = z.object({ start: z.number().min(0), end: z.number().min(0) });

export const EDL_STYLE_SCHEMA = z
  .object({
    grade: z.enum(GRADE_NAMES).default('none'),
    backgroundFill: z.enum(['crop', 'fill-blur']).default('crop'),
    punchIn: z.boolean().default(true),
    transition: z
      .object({
        type: z.enum(TRANSITION_TYPES).default('fade'),
        duration: z.number().min(0.2).max(1).default(0.5),
      })
      .default({ type: 'fade', duration: 0.5 }),
    edgeFade: z.boolean().default(false),
    progressBar: z.boolean().default(false),
    accentColor: z.string().regex(HEX).default('#FFD400'),
  })
  .strict();

export const FRAMING_SCHEMA = range
  .extend({
    shot: z.enum(SHOT_SIZES),
    focus: z.enum(['speaker', 'center']).default('speaker'),
    ease: z.number().min(0.15).max(2).default(0.6),
  })
  .strict();

export const TITLE_SCHEMA = range
  .extend({
    text: z.string().min(1).max(120),
    sub: z.string().max(80).optional(),
    position: z.enum(GRAPHIC_POSITIONS).default('center'),
  })
  .strict();

export const LOWER_THIRD_SCHEMA = range
  .extend({
    name: z.string().min(1).max(60),
    role: z.string().max(60).optional(),
  })
  .strict();

export const STAT_CARD_SCHEMA = range
  .extend({
    value: z.string().min(1).max(20),
    label: z.string().min(1).max(80),
    position: z.enum(GRAPHIC_POSITIONS).default('center'),
  })
  .strict();

export const CALLOUT_SCHEMA = range
  .extend({
    text: z.string().min(1).max(80),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    pointer: z.enum(CALLOUT_POINTERS).default('arrow'),
  })
  .strict();

export const BROLL_SCHEMA = range
  .extend({
    assetId: z.string().min(1).max(40).nullable().default(null),
    query: z.string().max(200).nullable().default(null),
    mode: z.enum(BROLL_MODES).default('cover'),
    position: z.enum(PIP_POSITIONS).default('bottom-right'),
    sizePercent: z.number().min(15).max(60).default(34),
  })
  .strict();

export const SFX_SCHEMA = z
  .object({
    libraryId: z.string().min(1).max(40),
    at: z.number().min(0),
    volumeDb: z.number().min(-40).max(6).default(-6),
  })
  .strict();

export const EMPHASIS_SCHEMA = z
  .object({
    text: z.string().min(1).max(60),
    role: z.enum(EDL_EMPHASIS_ROLES),
    color: z.string().regex(HEX).optional(),
  })
  .strict();

export const EDL_MUSIC_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    /** 'ai' | 'none' | <music asset id> */
    selection: z.string().min(1).max(60).default('ai'),
    volumeDb: z.number().min(-40).max(12).default(0),
    duckDb: z.number().min(0).max(30).default(7),
    fadeIn: z.number().min(0).max(10).default(0.8),
    fadeOut: z.number().min(0).max(10).default(1.5),
  })
  .strict();

export const EDL_SCHEMA = z
  .object({
    version: z.literal(EDL_VERSION),
    aspectRatio: z.enum(EDL_ASPECTS),
    style: EDL_STYLE_SCHEMA,
    framings: z.array(FRAMING_SCHEMA).max(60).default([]),
    titles: z.array(TITLE_SCHEMA).max(12).default([]),
    lowerThirds: z.array(LOWER_THIRD_SCHEMA).max(6).default([]),
    statCards: z.array(STAT_CARD_SCHEMA).max(10).default([]),
    callouts: z.array(CALLOUT_SCHEMA).max(20).default([]),
    broll: z.array(BROLL_SCHEMA).max(20).default([]),
    sfx: z.array(SFX_SCHEMA).max(12).default([]),
    emphasis: z.array(EMPHASIS_SCHEMA).max(40).default([]),
    music: EDL_MUSIC_SCHEMA.nullable().default(null),
    audio: z
      .object({
        cleanup: z.boolean().default(true),
        ducking: z.boolean().default(true),
      })
      .strict()
      .default({ cleanup: true, ducking: true }),
  })
  .strict();

export type EdlStyle = z.infer<typeof EDL_STYLE_SCHEMA>;
export type Framing = z.infer<typeof FRAMING_SCHEMA>;
export type TitleCard = z.infer<typeof TITLE_SCHEMA>;
export type LowerThird = z.infer<typeof LOWER_THIRD_SCHEMA>;
export type StatCard = z.infer<typeof STAT_CARD_SCHEMA>;
export type Callout = z.infer<typeof CALLOUT_SCHEMA>;
export type BrollPlacement = z.infer<typeof BROLL_SCHEMA>;
export type SfxPlacement = z.infer<typeof SFX_SCHEMA>;
export type EdlEmphasis = z.infer<typeof EMPHASIS_SCHEMA>;
export type EdlMusic = z.infer<typeof EDL_MUSIC_SCHEMA>;
export type Edl = z.infer<typeof EDL_SCHEMA>;

export interface EdlContext {
  /** output timeline duration (after the hook reorder) */
  duration: number;
  aspectRatio: EdlAspect;
  clipStart: number;
  clipEnd: number;
  transcript?: TranscriptSegment[] | null;
  words?: ClipWord[] | null;
  scene?: SceneAnalysis | null;
  /** valid asset ids (resolution to files happens later, in the asset services) */
  brollIds?: string[];
  musicIds?: string[];
  sfxIds?: string[];
  /** output-time windows that contain speech (for ducking/caption safety hints) */
  speechRanges?: { start: number; end: number }[];
}

export interface EdlResult {
  ok: boolean;
  edl: Edl | null;
  errors: string[];
  warnings: string[];
  dropped: string[];
}

export const MIN_GRAPHIC_DURATION = 0.6;
export const MIN_BROLL_DURATION = 0.8;

const MAX_PIP_COUNT = 4;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Clamp a time range into [0,duration]; null when it collapses. */
export function clampRange(r: { start: number; end: number }, duration: number, minDuration = 0.1): { start: number; end: number } | null {
  const start = Math.max(0, Math.min(duration, round3(r.start)));
  const end = Math.max(0, Math.min(duration, round3(r.end)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < minDuration) return null;
  return { start, end };
}

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, Number.isFinite(n) ? n : a));
}

/** Trim overlapping framings (earlier wins) and keep them ordered. */
export function normalizeFramings(framings: Framing[], duration: number): Framing[] {
  const sorted = [...framings].sort((a, b) => a.start - b.start);
  const out: Framing[] = [];
  for (const f of sorted) {
    const range = clampRange(f, duration, 0.3);
    if (!range) continue;
    const last = out[out.length - 1];
    if (last && range.start < last.end) {
      if (last.end - range.start < 0.3) continue; // swallowed by the previous framing
      range.start = last.end;
    }
    out.push({ ...f, ...range });
  }
  return out;
}

export function sortRanges<T extends { start: number; end: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.start - b.start || a.end - b.end);
}

function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '');
}

/**
 * Validate and normalize a raw EDL (typically produced by the Creative Director
 * or loaded from the plan cache). Every timestamp is clamped to the output
 * timeline, overlapping framings are trimmed, unknown asset ids are dropped with
 * a warning and emphasis words that never occur in the transcript are removed.
 */
export function validateEdl(raw: unknown, ctx: EdlContext): EdlResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dropped: string[] = [];
  const parsed = EDL_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      edl: null,
      errors: [`invalid EDL: ${first?.path.join('.') || '(root)'} ${first?.message ?? 'schema error'}`],
      warnings,
      dropped,
    };
  }
  const e = parsed.data;
  if (e.aspectRatio !== ctx.aspectRatio) {
    warnings.push(`aspectRatio ${e.aspectRatio} overridden by render option ${ctx.aspectRatio}`);
  }
  const aspectRatio = ctx.aspectRatio;
  const duration = ctx.duration;
  if (!(duration > 0)) errors.push('output duration must be positive');
  if (errors.length) return { ok: false, edl: null, errors, warnings, dropped };

  const framings = normalizeFramings(e.framings, duration);
  const normalizeGraphics = <T extends { start: number; end: number }>(items: T[], label: string, minDur = MIN_GRAPHIC_DURATION): T[] => {
    const out: T[] = [];
    for (const item of sortRanges(items)) {
      const r = clampRange(item, duration, minDur);
      if (!r) {
        dropped.push(`${label} outside the timeline: ${item.start.toFixed(1)}-${item.end.toFixed(1)}s`);
        continue;
      }
      out.push({ ...item, ...r });
    }
    return out;
  };

  const titles = normalizeGraphics(e.titles, 'title');
  const lowerThirds = normalizeGraphics(e.lowerThirds, 'lower-third');
  const statCards = normalizeGraphics(e.statCards, 'stat card');
  const callouts = normalizeGraphics(e.callouts, 'callout').map((c) => ({ ...c, x: clamp(c.x, 0.02, 0.98), y: clamp(c.y, 0.02, 0.98) }));

  const brollIds = new Set(ctx.brollIds ?? []);
  let pipCount = 0;
  const broll: BrollPlacement[] = [];
  for (const b of sortRanges(e.broll)) {
    const r = clampRange(b, duration, MIN_BROLL_DURATION);
    if (!r) {
      dropped.push(`b-roll outside the timeline: ${b.start.toFixed(1)}-${b.end.toFixed(1)}s`);
      continue;
    }
    if (b.assetId && brollIds.size > 0 && !brollIds.has(b.assetId)) {
      dropped.push(`b-roll asset ${b.assetId} is not in the library`);
      continue;
    }
    if (b.mode === 'pip' && pipCount >= MAX_PIP_COUNT) {
      dropped.push(`too many picture-in-picture b-roll placements (max ${MAX_PIP_COUNT})`);
      continue;
    }
    if (b.mode === 'pip') pipCount++;
    broll.push({ ...b, ...r });
  }

  const sfxIds = new Set(ctx.sfxIds ?? []);
  const sfx: SfxPlacement[] = [];
  for (const s of e.sfx) {
    if (s.at < 0 || s.at > Math.max(0, duration - 0.2)) {
      dropped.push(`sfx ${s.libraryId} starts outside the timeline (${s.at.toFixed(2)}s)`);
      continue;
    }
    if (sfxIds.size > 0 && !sfxIds.has(s.libraryId)) {
      dropped.push(`sfx asset ${s.libraryId} is not in the library`);
      continue;
    }
    sfx.push({ ...s, at: round3(s.at) });
  }

  const wordSet = new Set<string>();
  for (const w of ctx.words ?? []) wordSet.add(normWord(w.text));
  for (const t of ctx.transcript ?? []) for (const tok of t.text.split(/\s+/)) if (tok) wordSet.add(normWord(tok));
  const emphasis: EdlEmphasis[] = [];
  const seen = new Set<string>();
  for (const em of e.emphasis) {
    const key = normWord(em.text);
    if (!key || seen.has(key)) continue;
    if (wordSet.size > 0 && !wordSet.has(key)) {
      warnings.push(`emphasis word "${em.text}" is not in the transcript and was dropped`);
      continue;
    }
    seen.add(key);
    emphasis.push(em);
  }

  let music = e.music;
  if (music) {
    const musicIds = new Set(ctx.musicIds ?? []);
    if (music.selection !== 'ai' && music.selection !== 'none' && musicIds.size > 0 && !musicIds.has(music.selection)) {
      warnings.push(`music asset ${music.selection} is not in the library; falling back to AI selection`);
      music = { ...music, selection: 'ai' };
    }
  }

  const edl: Edl = {
    ...e,
    aspectRatio,
    framings,
    titles,
    lowerThirds,
    statCards,
    callouts,
    broll,
    sfx,
    emphasis,
    music,
    style: {
      ...e.style,
      transition: {
        type: e.style.transition.type,
        duration: clamp(e.style.transition.duration, 0.2, Math.min(1, Math.max(0.2, duration / 4))),
      },
    },
  };
  return { ok: true, edl, errors, warnings, dropped };
}

/* ---------------- zoom curve (punch-in / punch-out) ---------------- */

export const SHOT_ZOOM: Record<ShotSize, number> = { wide: 1, medium: 1.1, close: 1.24 };

export interface ZoomKey {
  t: number;
  z: number;
}

/**
 * Convert framings into a piecewise-linear zoom curve over the OUTPUT timeline.
 * Punch-in happens over `ease` seconds around each framing boundary. Adjacent
 * framings transition directly into each other — the curve only returns to 1
 * where there is a real gap, so the zoom never drifts out mid-shot.
 */
export function buildZoomKeys(framings: Framing[], duration: number, enabled = true): ZoomKey[] {
  if (!enabled || !framings.length) return [{ t: 0, z: 1 }];
  const fs = normalizeFramings(framings, duration);
  if (!fs.length) return [{ t: 0, z: 1 }];
  const zoomOf = (f: Framing) => clamp(SHOT_ZOOM[f.shot] ?? 1, 1, 1.3);
  const keys: ZoomKey[] = [{ t: 0, z: 1 }];
  for (const [i, f] of fs.entries()) {
    const z = zoomOf(f);
    const prev = fs[i - 1];
    const next = fs[i + 1];
    const half = Math.min(f.ease, (f.end - f.start) / 2) / 2;
    const prevAbuts = !!prev && f.start - prev.end < 0.02;
    const nextAbuts = !!next && next.start - f.end < 0.02;
    pushKey(keys, f.start - half, prevAbuts ? zoomOf(prev) : 1);
    pushKey(keys, f.start + half, z);
    pushKey(keys, f.end - half, z);
    pushKey(keys, f.end + half, nextAbuts ? zoomOf(next) : 1);
  }
  pushKey(keys, duration, 1);
  return normalizeKeys(keys, duration);
}

function pushKey(keys: ZoomKey[], t: number, z: number) {
  const tt = round3(Math.max(0, t));
  const last = keys[keys.length - 1];
  if (last && Math.abs(last.t - tt) < 0.01) {
    last.z = round3(z);
    return;
  }
  keys.push({ t: tt, z: round3(z) });
}

function normalizeKeys(keys: ZoomKey[], duration: number): ZoomKey[] {
  const sorted = keys.filter((k) => k.t >= 0 && k.t <= duration + 0.001).sort((a, b) => a.t - b.t);
  const out: ZoomKey[] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - k.t) < 0.01) last.z = k.z;
    else out.push({ t: round3(k.t), z: k.z });
  }
  if (!out.length || out[0].t > 0.01) out.unshift({ t: 0, z: out[0]?.z ?? 1 });
  if (out[out.length - 1].t < duration - 0.01) out.push({ t: round3(duration), z: out[out.length - 1].z });
  return out;
}

/** Interpolate the zoom at an output time (used by tests and reviewers). */
export function zoomAt(keys: ZoomKey[], t: number): number {
  if (!keys.length) return 1;
  if (t <= keys[0].t) return keys[0].z;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const span = Math.max(0.001, b.t - a.t);
      return a.z + (b.z - a.z) * ((t - a.t) / span);
    }
  }
  return keys[keys.length - 1].z;
}

/* ---------------- overlay layout + collision detection ---------------- */

export type LayoutKind = 'caption' | 'title' | 'lower-third' | 'stat-card' | 'callout' | 'progress-bar' | 'watermark' | 'broll';

export interface LayoutBox {
  id: string;
  kind: LayoutKind;
  start: number;
  end: number;
  /** normalized 0..1 frame coordinates */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  priority: number;
}

export const LAYOUT_PRIORITY: Record<LayoutKind, number> = {
  caption: 100,
  title: 70,
  callout: 60,
  'stat-card': 45,
  'lower-third': 50,
  watermark: 20,
  broll: 30,
  'progress-bar': 10,
};

export interface OverlayLayoutOptions {
  captionBand?: { y0: number; y1: number } | null;
  watermarkBands?: { id: string; start: number; end: number; x0: number; x1: number; y0: number; y1: number }[];
}

const GRAPHIC_BANDS: Record<GraphicPosition, { y0: number; y1: number }> = {
  top: { y0: 0.08, y1: 0.3 },
  center: { y0: 0.32, y1: 0.62 },
  bottom: { y0: 0.62, y1: 0.82 },
};

/** Compute normalized layout boxes for every timed graphic in the EDL. */
export function overlayLayout(edl: Edl, opts: OverlayLayoutOptions = {}): LayoutBox[] {
  const boxes: LayoutBox[] = [];
  const add = (id: string, kind: LayoutKind, start: number, end: number, x0: number, x1: number, y0: number, y1: number) => {
    boxes.push({ id, kind, start, end, x0: clamp(x0, 0, 1), x1: clamp(x1, 0, 1), y0: clamp(y0, 0, 1), y1: clamp(y1, 0, 1), priority: LAYOUT_PRIORITY[kind] });
  };
  if (opts.captionBand) {
    add('captions', 'caption', 0, Number.MAX_SAFE_INTEGER, 0.05, 0.95, opts.captionBand.y0, opts.captionBand.y1);
  }
  for (const [i, t] of edl.titles.entries()) {
    const b = GRAPHIC_BANDS[t.position];
    add(`title:${i}`, 'title', t.start, t.end, 0.08, 0.92, b.y0, b.y1);
  }
  for (const [i, s] of edl.statCards.entries()) {
    const b = GRAPHIC_BANDS[s.position];
    add(`stat:${i}`, 'stat-card', s.start, s.end, 0.12, 0.88, b.y0, b.y1);
  }
  for (const [i, lt] of edl.lowerThirds.entries()) {
    add(`lower:${i}`, 'lower-third', lt.start, lt.end, 0.04, 0.66, 0.68, 0.88);
  }
  for (const [i, c] of edl.callouts.entries()) {
    // callout text box sits just above the pointer point
    add(`callout:${i}`, 'callout', c.start, c.end, clamp(c.x - 0.22, 0.02, 0.98), clamp(c.x + 0.22, 0.02, 0.98), clamp(c.y - 0.16, 0.02, 0.98), clamp(c.y + 0.04, 0.02, 0.98));
  }
  for (const [i, b] of edl.broll.entries()) {
    if (b.mode === 'cover') continue; // full frame: intentional, not a collision
    const w = b.sizePercent / 100;
    const h = w * 1.1;
    const pos: Record<PipPosition, { x0: number; y0: number }> = {
      'top-left': { x0: 0.04, y0: 0.06 },
      'top-right': { x0: 0.96 - w, y0: 0.06 },
      'bottom-left': { x0: 0.04, y0: 0.9 - h },
      'bottom-right': { x0: 0.96 - w, y0: 0.9 - h },
    };
    const p = pos[b.position];
    add(`broll:${i}`, 'broll', b.start, b.end, p.x0, p.x0 + w, p.y0, p.y0 + h);
  }
  if (edl.style.progressBar) {
    add('progress', 'progress-bar', 0, Number.MAX_SAFE_INTEGER, 0.05, 0.95, 0.965, 0.985);
  }
  for (const w of opts.watermarkBands ?? []) {
    add(w.id, 'watermark', w.start, w.end, w.x0, w.x1, w.y0, w.y1);
  }
  return boxes;
}

export interface Collision {
  a: LayoutBox;
  b: LayoutBox;
  overlapSec: number;
  area: number;
}

/** Pairs whose time and area overlap enough to hurt readability. */
export function findCollisions(boxes: LayoutBox[], minOverlapSec = 0.15, minArea = 0.008): Collision[] {
  const out: Collision[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapSec = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlapSec < minOverlapSec) continue;
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      if (area < minArea) continue;
      out.push({ a, b, overlapSec: round3(overlapSec), area: round3(area) });
    }
  }
  return out;
}

/* ---------------- limited EDL repair ---------------- */

export type EdlProblemCode =
  | 'overlay_collision'
  | 'subtitle_safe_area'
  | 'broll_unresolved'
  | 'broll_window'
  | 'audio_clipping'
  | 'face_framing'
  | 'black_frames'
  | 'timing';

export interface EdlProblem {
  code: EdlProblemCode;
  detail: string;
  /** layout ids like "title:0", "lower:1", "broll:2" or asset ids */
  ids?: string[];
}

export interface RepairResult {
  edl: Edl;
  applied: string[];
}

/**
 * Deterministic, bounded repair: only drops/moves/de-escalates creative items,
 * never changes the underlying clip, transcript or timing contract.
 */
export function repairEdl(edl: Edl, problems: EdlProblem[]): RepairResult {
  const applied: string[] = [];
  let next = {
    ...edl,
    titles: [...edl.titles],
    lowerThirds: [...edl.lowerThirds],
    statCards: [...edl.statCards],
    callouts: [...edl.callouts],
    broll: [...edl.broll],
    sfx: [...edl.sfx],
    framings: [...edl.framings],
    emphasis: [...edl.emphasis],
    style: { ...edl.style },
  } as Edl;

  const dropIds = new Set<string>();
  for (const p of problems) {
    switch (p.code) {
      case 'overlay_collision':
      case 'subtitle_safe_area': {
        const [rawA, rawB] = (p.ids ?? []).slice(0, 2);
        const kindOf = (id?: string) => (id === 'captions' || id === 'caption' ? 'caption' : id?.split(':')[0]);
        const kinds = [rawA, rawB].map(kindOf);
        // prefer dropping the non-caption item; when both are graphics drop the lower priority
        const toDrop = kinds[0] === 'caption' ? rawB : kinds[1] === 'caption' ? rawA : pickLowerPriority(rawA, rawB);
        if (toDrop) dropIds.add(toDrop);
        applied.push(`dropped ${toDrop ?? 'colliding overlay'} (${p.detail})`);
        break;
      }
      case 'broll_unresolved':
      case 'broll_window': {
        for (const id of p.ids ?? []) dropIds.add(id);
        applied.push(`dropped b-roll (${p.detail})`);
        break;
      }
      case 'audio_clipping': {
        const ids = p.ids ?? [];
        if (ids.length) {
          for (const id of ids) {
            const i = Number(id.split(':')[1]);
            const s = next.sfx[i];
            if (!s) continue;
            if (s.volumeDb > -18) {
              next.sfx[i] = { ...s, volumeDb: round3(s.volumeDb - 6) };
              applied.push(`attenuated sfx ${i} by 6 dB`);
            } else {
              next.sfx = next.sfx.filter((_, j) => j !== i);
              applied.push(`removed sfx ${i} (still clipping)`);
            }
          }
        } else if (next.music) {
          next.music = { ...next.music, volumeDb: round3(next.music.volumeDb - 3) };
          applied.push('lowered background music by 3 dB');
        }
        break;
      }
      case 'face_framing': {
        next.framings = [];
        next.style = { ...next.style, punchIn: false };
        applied.push('disabled punch-in framing');
        break;
      }
      case 'black_frames': {
        const spans = (p.ids ?? []).map((id) => id.split('|').map(Number)).filter((r) => r.length === 2 && r.every(Number.isFinite));
        if (spans.length) {
          next.broll = next.broll.filter((b) => !spans.some(([a, bEnd]) => b.start < bEnd && b.end > a));
        }
        if (next.style.edgeFade) {
          next.style = { ...next.style, edgeFade: false };
          applied.push('disabled edge fades');
        }
        applied.push('removed b-roll covering black frames');
        break;
      }
      case 'timing': {
        next.framings = next.framings.filter((f) => f.end > f.start);
        applied.push('removed invalid framing windows');
        break;
      }
    }
  }

  if (dropIds.size) {
    const keep = (id: string) => !dropIds.has(id);
    next.titles = next.titles.filter((_, i) => keep(`title:${i}`));
    next.lowerThirds = next.lowerThirds.filter((_, i) => keep(`lower:${i}`));
    next.statCards = next.statCards.filter((_, i) => keep(`stat:${i}`));
    next.callouts = next.callouts.filter((_, i) => keep(`callout:${i}`));
    next.broll = next.broll.filter((_, i) => keep(`broll:${i}`));
  }
  return { edl: next, applied };
}

function pickLowerPriority(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const kindOf = (id: string) => (id.split(':')[0] === 'lower' ? 'lower-third' : id.split(':')[0] === 'stat' ? 'stat-card' : id.split(':')[0] === 'progress' ? 'progress-bar' : (id.split(':')[0] as LayoutKind));
  const pa = LAYOUT_PRIORITY[kindOf(a)] ?? 0;
  const pb = LAYOUT_PRIORITY[kindOf(b)] ?? 0;
  return pa <= pb ? a : b;
}

/* ---------------- deterministic fallback EDL ---------------- */

export interface FallbackEdlInput {
  aspectRatio: EdlAspect;
  duration: number;
  clipStart: number;
  clipEnd: number;
  style: EdlStyle;
  title?: string | null;
  hookText?: string | null;
  hookEnd?: number | null;
  scene?: SceneAnalysis | null;
  words?: ClipWord[] | null;
  subtitlePlan?: PlannedWordStyle[] | null;
  music?: EdlMusic | null;
  transcript?: TranscriptSegment[] | null;
}

/**
 * Build a complete, deterministic EDL when the model is unavailable or its
 * output fails validation. Uses only local signals: title -> intro card,
 * face/shot analysis -> framing, subtitle plan -> keyword emphasis.
 */
export function buildFallbackEdl(input: FallbackEdlInput): Edl {
  const duration = round3(Math.max(0.5, input.duration));
  const scene = input.scene ?? null;
  const framings: Framing[] = [];
  if (scene && scene.faceCoverage >= 0.25 && input.style.punchIn) {
    const hookEnd = clamp(input.hookEnd ?? 0, 0, duration);
    if (hookEnd >= 3) {
      framings.push({ start: 0, end: round3(hookEnd), shot: 'close', focus: 'speaker', ease: 0.6 });
    }
    const bodyStart = hookEnd >= 3 ? round3(hookEnd) : 0;
    if (duration - bodyStart >= 4) {
      const hint = scene.shotHints.find((h) => h.size !== 'wide');
      framings.push({ start: bodyStart, end: duration, shot: hint?.size === 'close' ? 'medium' : 'medium', focus: 'speaker', ease: 0.8 });
    }
  }

  const titles: TitleCard[] = [];
  const introText = (input.title ?? '').trim() || (input.hookText ?? '').trim();
  if (introText && duration >= 4) {
    titles.push({
      text: introText.slice(0, 80),
      start: 0.5,
      end: round3(Math.min(duration - 0.5, 3.8)),
      position: 'center',
    });
  }

  const emphasis: EdlEmphasis[] = (input.subtitlePlan ?? [])
    .slice(0, 12)
    .flatMap((p): EdlEmphasis[] => {
      const w = input.words?.find((x) => x.index === p.index);
      if (!w) return [];
      const item: EdlEmphasis = { text: w.text, role: p.role as EdlEmphasisRole };
      if (p.color) item.color = p.color;
      return [item];
    });

  return {
    version: EDL_VERSION,
    aspectRatio: input.aspectRatio,
    style: { ...input.style },
    framings,
    titles,
    lowerThirds: [],
    statCards: [],
    callouts: [],
    broll: [],
    sfx: [],
    emphasis,
    music: input.music ?? null,
    audio: { cleanup: true, ducking: true },
  };
}

/** Small helper for logs: one-line EDL summary. */
export function edlSummary(edl: Edl): string {
  return (
    `grade=${edl.style.grade} fill=${edl.style.backgroundFill} punch=${edl.style.punchIn} ` +
    `framings=${edl.framings.length} titles=${edl.titles.length} lower=${edl.lowerThirds.length} ` +
    `stats=${edl.statCards.length} callouts=${edl.callouts.length} broll=${edl.broll.length} ` +
    `sfx=${edl.sfx.length} emphasis=${edl.emphasis.length}`
  );
}

export function logEdlWarnings(source: string, result: EdlResult): void {
  for (const w of result.warnings) logger.debug('AI', `${source}: ${w}`);
  for (const d of result.dropped) logger.info('AI', `${source}: dropped ${d}`);
}
