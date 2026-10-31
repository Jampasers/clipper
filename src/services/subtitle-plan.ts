import { z } from 'zod';
import { generate } from '../lib/ai.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';
import type { TranscriptSegment } from './transcribe.js';

/**
 * AI dynamic subtitles. Whisper word timestamps stay the source of truth for
 * timing; AI only assigns semantic roles / visual emphasis to existing words
 * (by index), and every assignment is schema-validated before use.
 */

export const SUBTITLE_ROLES = ['normal', 'important', 'number', 'emotion', 'punchline', 'hook', 'question', 'conclusion'] as const;
export type SubtitleRole = (typeof SUBTITLE_ROLES)[number];

export const SUBTITLE_ANIMATIONS = ['none', 'pop', 'bounce', 'fade', 'slide', 'shake'] as const;
export type SubtitleAnimation = (typeof SUBTITLE_ANIMATIONS)[number];

export interface WordStyle {
  role: SubtitleRole;
  color?: string;
  scale?: number;
  fontWeight?: number;
  animation: SubtitleAnimation;
}

export interface ClipWord {
  index: number;
  text: string;
  start: number;
  end: number;
  segmentIndex: number;
}

export interface PlannedWordStyle {
  index: number;
  role: Exclude<SubtitleRole, 'normal'>;
  color?: string;
  scale?: number;
  animation: SubtitleAnimation;
  priority: number;
}

export interface SubtitleEditingPlan {
  words: PlannedWordStyle[];
  source: 'ai' | 'fallback';
  model: string;
}

export const WORD_STYLE_SCHEMA = z.object({
  index: z.number().int().min(0),
  role: z.enum(SUBTITLE_ROLES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  scale: z.number().min(0.9).max(1.8).optional(),
  animation: z.enum(SUBTITLE_ANIMATIONS).optional(),
  priority: z.number().min(1).max(10).optional(),
});

const AI_PLAN_SCHEMA = z.object({ words: z.array(WORD_STYLE_SCHEMA).max(400) });

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Flatten the clip's transcript into indexed words (synthesized if Whisper had no word timing). */
export function collectClipWords(segments: TranscriptSegment[], clipStart: number, clipEnd: number): ClipWord[] {
  const out: ClipWord[] = [];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    if (seg.words && seg.words.length) {
      for (const w of seg.words) {
        if (w.end <= clipStart || w.start >= clipEnd) continue;
        const text = String(w.word ?? '').trim();
        if (!text) continue;
        out.push({ index: out.length, text, start: Math.max(clipStart, w.start), end: Math.min(clipEnd, w.end), segmentIndex: si });
      }
    } else {
      const text = seg.text.trim();
      if (!text) continue;
      const tokens = text.split(/\s+/).filter(Boolean);
      const s = Math.max(clipStart, seg.start);
      const e = Math.min(clipEnd, seg.end);
      const step = Math.max(0.01, (e - s) / Math.max(1, tokens.length));
      tokens.forEach((t, i) => {
        out.push({ index: out.length, text: t, start: s + step * i, end: s + step * (i + 1), segmentIndex: si });
      });
    }
  }
  return out;
}

/** Prompt input: global word indexes grouped per subtitle segment. */
export function formatWordsForPrompt(words: ClipWord[]): string {
  const lines: string[] = [];
  let currentSeg = -1;
  for (const w of words) {
    if (w.segmentIndex !== currentSeg) {
      if (currentSeg !== -1) lines.push('---');
      currentSeg = w.segmentIndex;
    }
    lines.push(`${w.index}: ${w.text} [${w.start.toFixed(1)}-${w.end.toFixed(1)}]`);
  }
  return lines.join('\n');
}

/** Default visual for a semantic role. */
export function resolveWordVisual(role: Exclude<SubtitleRole, 'normal'>, accentColor?: string): WordStyle {
  const accent = accentColor && HEX.test(accentColor) ? accentColor : '#FFD400';
  switch (role) {
    case 'number':
      return { role, color: accent, scale: 1.22, animation: 'pop', fontWeight: 900 };
    case 'punchline':
      return { role, color: '#FF3D00', scale: 1.2, animation: 'pop', fontWeight: 900 };
    case 'emotion':
      return { role, color: '#FF7A59', scale: 1.12, animation: 'bounce', fontWeight: 800 };
    case 'hook':
      return { role, color: accent, scale: 1.2, animation: 'pop', fontWeight: 900 };
    case 'question':
      return { role, color: '#8AB4FF', scale: 1.08, animation: 'slide', fontWeight: 700 };
    case 'conclusion':
      return { role, color: '#7CFFB2', scale: 1.1, animation: 'fade', fontWeight: 800 };
    case 'important':
    default:
      return { role: 'important', color: accent, scale: 1.14, animation: 'pop', fontWeight: 900 };
  }
}

const STOPWORD_MARKERS = new Set([
  'nggak', 'tidak', 'bukan', 'jangan', 'sangat', 'paling', 'hanya', 'juta', 'miliar', 'milyar', 'ribu',
  'persen', 'pertama', 'terakhir', 'rahasia', 'ternyata', 'padahal', 'gila', 'wow', 'amazing', 'never',
  'most', 'million', 'billion', 'percent', 'best', 'worst', 'hate', 'love', 'gratis', 'percaya',
]);

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '');
}

/**
 * Deterministic fallback: numbers, strong markers and questions get emphasis.
 * Never random, never the whole sentence.
 */
export function fallbackSubtitlePlan(words: ClipWord[], accentColor?: string): PlannedWordStyle[] {
  if (!words.length) return [];
  const perSegment = new Map<number, number>();
  const picks: PlannedWordStyle[] = [];
  const segText = new Map<number, string>();
  const push = (w: ClipWord, role: Exclude<SubtitleRole, 'normal'>, priority: number) => {
    if (picks.some((p) => p.index === w.index)) return;
    const n = perSegment.get(w.segmentIndex) ?? 0;
    if (n >= 3) return;
    perSegment.set(w.segmentIndex, n + 1);
    const visual = resolveWordVisual(role, accentColor);
    picks.push({ index: w.index, role, color: visual.color, scale: visual.scale, animation: visual.animation, priority });
  };

  for (const w of words) {
    if (!segText.has(w.segmentIndex)) segText.set(w.segmentIndex, '');
    segText.set(w.segmentIndex, (segText.get(w.segmentIndex) ?? '') + ' ' + w.text);
  }

  for (const w of words) {
    const clean = norm(w.text);
    const isNumber = /\d/.test(w.text) || /^(juta|miliar|milyar|ribu|persen|million|billion|percent)$/i.test(clean);
    if (isNumber) {
      push(w, 'number', 9);
      continue;
    }
    const isQuestion = (segText.get(w.segmentIndex) ?? '').includes('?');
    if (isQuestion && clean.length > 3 && !STOPWORD_MARKERS.has(clean)) {
      push(w, 'question', 6);
      continue;
    }
    if (STOPWORD_MARKERS.has(clean)) {
      push(w, 'punchline', 7);
      continue;
    }
    if (w.text.length >= 4 && w.text === w.text.toUpperCase() && /[A-Z]/.test(w.text)) {
      push(w, 'emotion', 6);
    }
  }
  return picks.slice(0, Math.max(2, Math.min(40, Math.ceil(words.length * 0.2))));
}

/** Validate + normalize raw AI output against the real word list. */
export function normalizeSubtitlePlan(raw: unknown, words: ClipWord[], accentColor?: string): PlannedWordStyle[] {
  if (!raw || typeof raw !== 'object') return [];
  const parsed = AI_PLAN_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    logger.warn('AI', `subtitle plan rejected by schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return [];
  }
  const byIndex = new Map(words.map((w) => [w.index, w]));
  const out: PlannedWordStyle[] = [];
  const seen = new Set<number>();
  for (const item of parsed.data.words) {
    if (seen.has(item.index)) continue;
    const word = byIndex.get(item.index);
    if (!word) continue;
    if (item.role === 'normal') continue;
    if (word.text.trim().length < 2) continue;
    seen.add(item.index);
    const visual = resolveWordVisual(item.role as Exclude<SubtitleRole, 'normal'>, accentColor);
    out.push({
      index: item.index,
      role: item.role as Exclude<SubtitleRole, 'normal'>,
      color: item.color && HEX.test(item.color) ? item.color : visual.color,
      scale: clamp(item.scale ?? visual.scale ?? 1.14, 0.9, 1.8),
      animation: item.animation ?? visual.animation,
      priority: item.priority ?? 5,
    });
  }
  const cap = Math.max(2, Math.min(40, Math.ceil(words.length * 0.2)));
  out.sort((a, b) => b.priority - a.priority || a.index - b.index);
  return out.slice(0, cap).sort((a, b) => a.index - b.index);
}

/**
 * Ask the AI for the styling plan. Failure returns the deterministic fallback,
 * it never fails the render.
 */
export async function generateSubtitlePlan(words: ClipWord[]): Promise<SubtitleEditingPlan> {
  const accent = getSettings('subtitles').emphasis.color;
  if (!words.length) return { words: [], source: 'fallback', model: '' };
  try {
    const { json, model } = await generate<unknown>('subtitle_plan', { words: formatWordsForPrompt(words) });
    const normalized = normalizeSubtitlePlan(json, words, accent);
    if (!normalized.length) {
      logger.info('AI', 'subtitle plan produced no usable emphasis; using deterministic fallback');
      return { words: fallbackSubtitlePlan(words, accent), source: 'fallback', model };
    }
    return { words: normalized, source: 'ai', model };
  } catch (err: any) {
    logger.warn('AI', `subtitle plan failed (${String(err?.message).slice(0, 160)}); using fallback`);
    return { words: fallbackSubtitlePlan(words, accent), source: 'fallback', model: '' };
  }
}

/** The options that influence how a plan is applied visually. */
export interface StyleContext {
  style: 'ai' | 'bold' | 'karaoke' | 'kinetic';
  aiHighlight: boolean;
  animations: boolean;
  accentColor?: string;
}

/**
 * Convert a plan into render-time word styles, honoring the chosen style mode.
 * 'ai' keeps the plan; 'bold' restricts to the strongest roles; 'karaoke' leaves
 * emphasis to the karaoke engine; 'kinetic' boosts every highlighted word.
 */
export function resolveWordStyles(plan: PlannedWordStyle[] | null, ctx: StyleContext): Map<number, WordStyle> {
  const map = new Map<number, WordStyle>();
  if (!plan?.length) return map;
  const accent = ctx.accentColor;
  for (const item of plan) {
    if (ctx.style === 'karaoke') continue; // active-word color handled by the composition
    if (!ctx.aiHighlight && ctx.style === 'ai') continue;
    if (ctx.style === 'bold' && !['important', 'number', 'punchline', 'hook'].includes(item.role)) continue;
    const base = resolveWordVisual(item.role, accent);
    const style: WordStyle = {
      role: item.role,
      color: item.color ?? base.color,
      scale: item.scale ?? base.scale,
      fontWeight: base.fontWeight,
      animation: ctx.animations ? (item.animation ?? base.animation) : 'none',
    };
    if (ctx.style === 'kinetic') {
      style.scale = clamp((style.scale ?? 1.14) + 0.08, 0.9, 1.8);
      if (ctx.animations) style.animation = style.animation === 'none' ? 'pop' : style.animation;
    }
    map.set(item.index, style);
  }
  return map;
}

/**
 * Attach styles to a copy of the transcript segments (words matched by order,
 * exactly like collectClipWords), so timeline clipping can reuse them safely.
 */
export function annotateTranscript(
  segments: TranscriptSegment[],
  clipWords: ClipWord[],
  styles: Map<number, WordStyle>
): TranscriptSegment[] {
  const styleBySegmentWord = new Map<string, WordStyle>();
  for (const w of clipWords) {
    const st = styles.get(w.index);
    if (!st) continue;
    styleBySegmentWord.set(`${w.segmentIndex}|${w.start.toFixed(3)}|${w.end.toFixed(3)}|${w.text}`, st);
  }
  return segments.map((seg, si) => {
    if (!seg.words?.length) return seg;
    return {
      ...seg,
      words: seg.words.map((w) => {
        const st = styleBySegmentWord.get(`${si}|${w.start.toFixed(3)}|${w.end.toFixed(3)}|${String(w.word ?? '').trim()}`);
        return st ? { ...w, style: st } : w;
      }),
    };
  });
}

/** Words worth emphasizing for the legacy ASS burn-in path. */
export function styleEmphasisWords(plan: PlannedWordStyle[] | null, words: ClipWord[], max = 12): string[] {
  if (!plan?.length) return [];
  const byIndex = new Map(words.map((w) => [w.index, w.text]));
  return plan.map((p) => byIndex.get(p.index)).filter((t): t is string => !!t).slice(0, max);
}

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, Number.isFinite(n) ? n : a));
}
