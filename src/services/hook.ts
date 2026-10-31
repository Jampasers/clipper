import { z } from 'zod';
import { generate } from '../lib/ai.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';
import { formatTranscriptForPrompt, type TranscriptData } from './transcribe.js';
import { collectClipWords, formatWordsForPrompt, type ClipWord } from './subtitle-plan.js';
import { isHookSpanValid } from './timeline.js';

/**
 * Opening hook selection. AI proposes candidates by word index (so boundaries
 * are always real word edges); locally we validate range/duration and pick the
 * best. When AI is unavailable a deterministic candidate generator takes over,
 * and when nothing qualifies the clip renders without a hook.
 */

export interface HookCandidate {
  start: number;
  end: number;
  text: string;
  score: number;
  reason: string;
}

export interface HookPlan {
  start: number;
  end: number;
  text: string;
  reason: string;
  score: number;
  source: 'ai' | 'fallback';
  candidates: HookCandidate[];
}

const AI_HOOK_SCHEMA = z.object({
  candidates: z
    .array(
      z.object({
        start_word: z.number().int().min(0),
        end_word: z.number().int().min(0),
        score: z.number().min(0).max(100).optional(),
        reason: z.string().max(400).optional(),
      })
    )
    .max(10),
});

export function hookWindow(clipStart: number, clipEnd: number, target: number, min: number, max: number) {
  return { clipStart, clipEnd, target, min, max };
}

/** Convert raw AI candidates (word indexes) into validated, deduplicated candidates. */
export function validateHookCandidates(
  raw: unknown,
  words: ClipWord[],
  clipStart: number,
  clipEnd: number,
  minDuration: number,
  maxDuration: number
): HookCandidate[] {
  if (!raw || typeof raw !== 'object') return [];
  const parsed = AI_HOOK_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    logger.warn('AI', `hook candidates rejected by schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return [];
  }
  const out: HookCandidate[] = [];
  for (const c of parsed.data.candidates) {
    if (c.end_word < c.start_word) continue;
    const slice = words.filter((w) => w.index >= c.start_word && w.index <= c.end_word);
    if (!slice.length) continue;
    const start = slice[0].start;
    const end = slice[slice.length - 1].end;
    if (!isHookSpanValid({ start, end }, clipStart, clipEnd, minDuration, maxDuration)) continue;
    const text = slice.map((w) => w.text).join(' ').trim();
    if (text.length < 8) continue;
    const cand: HookCandidate = {
      start: round3(start),
      end: round3(end),
      text,
      score: c.score ?? 0,
      reason: (c.reason ?? 'AI selected').slice(0, 300),
    };
    if (out.some((o) => Math.abs(o.start - cand.start) < 0.2 && Math.abs(o.end - cand.end) < 0.2)) continue;
    out.push(cand);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

const MARKERS = [
  'nggak', 'tidak', 'bukan', 'jangan', 'ternyata', 'padahal', 'rahasia', 'gila', 'wow', 'percaya',
  'juta', 'miliar', 'milyar', 'ribu', 'persen', 'pertama', 'terakhir', 'never', 'secret', 'shocking',
  'impossible', 'million', 'billion', 'percent', 'worst', 'best', 'untung', 'rugi', 'salah', 'bener',
];

/**
 * Deterministic hook candidates: sentence-aligned spans scored by interesting
 * markers, question/exclamation energy and closeness to the target duration.
 */
export function fallbackHookCandidates(
  words: ClipWord[],
  clipStart: number,
  clipEnd: number,
  target: number,
  minDuration: number,
  maxDuration: number
): HookCandidate[] {
  if (words.length < 4) return [];
  const segmentStartTimes = new Set(words.filter((w, i) => i === 0 || w.segmentIndex !== words[i - 1].segmentIndex).map((w) => w.start.toFixed(2)));
  const scored: HookCandidate[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!segmentStartTimes.has(words[i].start.toFixed(2))) continue; // start on a sentence, not mid-phrase
    for (let j = i + 1; j < words.length; j++) {
      const start = words[i].start;
      const end = words[j].end;
      const dur = end - start;
      if (dur > maxDuration) break;
      if (dur < minDuration) continue;
      const text = words.slice(i, j + 1).map((w) => w.text).join(' ').trim();
      if (text.length < 8) continue;
      let score = 0;
      const lower = text.toLowerCase();
      for (const m of MARKERS) if (lower.includes(m)) score += 6;
      if (/[?]/.test(text)) score += 5;
      if (/[!]/.test(text)) score += 2;
      if (/\d/.test(text)) score += 6;
      score += Math.max(0, 8 - Math.abs(dur - target) * 1.5);
      scored.push({ start: round3(start), end: round3(end), text, score: round1(score), reason: 'deterministic fallback (interesting markers / duration fit)' });
      break; // one candidate per sentence start (the shortest valid span)
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

export function pickHook(
  candidates: HookCandidate[],
  clipStart: number,
  clipEnd: number,
  minDuration: number,
  maxDuration: number
): HookCandidate | null {
  for (const c of candidates) {
    if (isHookSpanValid({ start: c.start, end: c.end }, clipStart, clipEnd, minDuration, maxDuration)) return c;
  }
  return null;
}

export interface HookOutcome {
  plan: HookPlan | null;
  candidates: HookCandidate[];
  source: 'ai' | 'fallback' | 'none';
  model: string;
}

/**
 * Ask AI for hook candidates; validate locally; fall back deterministically.
 * Never throws: a bad hook must not fail the whole render.
 */
export async function generateHookPlan(
  transcript: TranscriptData,
  clipStart: number,
  clipEnd: number,
  opts: { target: number; allowFallback: boolean }
): Promise<HookOutcome> {
  const settings = getSettings('hook');
  const minD = Math.max(2, settings.min_duration);
  const maxD = Math.max(minD + 1, settings.max_duration);
  const target = clamp(opts.target || settings.duration, minD, maxD);
  const clipDur = clipEnd - clipStart;
  if (clipDur < Math.max(6, minD + 2)) return { plan: null, candidates: [], source: 'none', model: '' };

  const words = collectClipWords(transcript.segments, clipStart, clipEnd);
  if (!words.length) return { plan: null, candidates: [], source: 'none', model: '' };

  let candidates: HookCandidate[] = [];
  let model = '';
  let aiFailed = false;
  try {
    const context = formatTranscriptForPrompt(transcript.segments, { start: clipStart - 25, end: clipEnd + 10, maxChars: 6000 });
    const { json, model: m } = await generate<unknown>('hook_generation', {
      clip_start: clipStart.toFixed(2),
      clip_end: clipEnd.toFixed(2),
      clip_duration: clipDur.toFixed(1),
      target_duration: target.toFixed(1),
      min_duration: minD.toFixed(1),
      max_duration: maxD.toFixed(1),
      words: formatWordsForPrompt(words),
      context,
    });
    model = m;
    candidates = validateHookCandidates(json, words, clipStart, clipEnd, minD, maxD);
  } catch (err: any) {
    aiFailed = true;
    logger.warn('AI', `hook generation failed (${String(err?.message).slice(0, 160)})`);
  }

  let chosen = pickHook(candidates, clipStart, clipEnd, minD, maxD);
  let source: HookOutcome['source'] = chosen ? 'ai' : 'none';
  if (!chosen && opts.allowFallback) {
    const fallback = fallbackHookCandidates(words, clipStart, clipEnd, target, minD, maxD);
    candidates = candidates.length ? candidates : fallback;
    chosen = pickHook(fallback, clipStart, clipEnd, minD, maxD);
    if (chosen) source = 'fallback';
  }
  if (!chosen) {
    logger.info('AI', `no usable hook for clip ${clipStart.toFixed(1)}-${clipEnd.toFixed(1)}s (aiFailed=${aiFailed}); rendering without hook`);
    return { plan: null, candidates, source: 'none', model };
  }
  logger.info('AI', `hook selected (${source}): ${chosen.start.toFixed(1)}-${chosen.end.toFixed(1)}s score=${chosen.score}`);
  return {
    plan: { ...chosen, source: source === 'ai' ? 'ai' : 'fallback', candidates },
    candidates,
    source,
    model,
  };
}

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, Number.isFinite(n) ? n : a));
}
function round3(n: number) { return Math.round(n * 1000) / 1000; }
function round1(n: number) { return Math.round(n * 10) / 10; }
