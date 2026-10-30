import { getSettings } from '../lib/settings.js';
import { generate } from '../lib/ai.js';
import { formatTranscriptForPrompt, type TranscriptSegment, type TranscriptData } from './transcribe.js';
import { logger } from '../lib/log.js';

export interface Moment {
  start_segment: number;
  end_segment: number;
  type: string;
  reason: string;
}

export interface CandidateRaw {
  start_segment: number;
  end_segment: number;
  title: string;
  hook: string;
  reason: string;
}

export interface ScoredCandidate extends CandidateRaw {
  start: number;
  end: number;
  duration: number;
  scores: Record<string, number>;
  overall_score: number;
  comment?: string;
}

/* ---------------- content analysis ---------------- */

export async function analyzeContent(projectId: string, transcript: TranscriptData): Promise<Moment[]> {
  const formatted = formatTranscriptForPrompt(transcript.segments, { maxChars: 48000 });
  const { json } = await generate<Moment[]>('content_analysis', {
    transcript: formatted,
    duration: Math.round(transcript.duration),
  });
  const arr = Array.isArray(json) ? json : [];
  const valid = arr.filter(
    (m) => Number.isInteger(m.start_segment) && Number.isInteger(m.end_segment) && m.start_segment >= 0 && m.end_segment < transcript.segments.length
  );
  logger.info('AI', `content analysis for ${projectId}: ${valid.length} moments`);
  return valid;
}

/* ---------------- candidate generation ---------------- */

export async function generateCandidates(projectId: string, transcript: TranscriptData, moments: Moment[]): Promise<CandidateRaw[]> {
  const clip = getSettings('clipping');
  const formatted = formatTranscriptForPrompt(transcript.segments, { maxChars: 48000 });
  const momentLines = moments
    .map((m) => `- segments ${m.start_segment}-${m.end_segment} (${m.type}): ${m.reason}`)
    .join('\n') || '(none — find moments yourself)';
  const { json } = await generate<CandidateRaw[]>('highlight_detection', {
    transcript: formatted,
    moments: momentLines,
    min_clip_duration: clip.min_clip_duration,
    max_clip_duration: clip.max_clip_duration,
    target_clip_duration: clip.target_clip_duration,
    max_candidates: clip.max_candidates,
  });
  const arr = Array.isArray(json) ? json : [];
  const valid = arr.filter(
    (c) =>
      Number.isInteger(c.start_segment) &&
      Number.isInteger(c.end_segment) &&
      c.start_segment >= 0 &&
      c.end_segment < transcript.segments.length &&
      c.end_segment >= c.start_segment &&
      typeof c.title === 'string'
  );
  if (!valid.length) {
    // Deterministic fallback so the pipeline never hard-fails on a stingy model:
    // windows from detected moments, or an even split of the transcript.
    const target = Math.max(clip.min_clip_duration, Math.min(clip.target_clip_duration, transcript.duration));
    if (moments.length) {
      for (const m of moments) {
        if (m.start_segment >= 0 && m.end_segment < transcript.segments.length && m.end_segment >= m.start_segment) {
          valid.push({
            start_segment: m.start_segment, end_segment: m.end_segment,
            title: (m.reason || m.type || 'highlight').slice(0, 80), hook: m.reason || '', reason: `fallback from moment (${m.type})`,
          });
        }
      }
    }
    let s = 0;
    while (!valid.length && s < transcript.segments.length) {
      let e = s;
      let end = transcript.segments[e].end;
      while (e + 1 < transcript.segments.length && end - transcript.segments[s].start < target) end = transcript.segments[++e].end;
      valid.push({ start_segment: s, end_segment: e, title: `Part ${s + 1}`, hook: '', reason: 'even split fallback' });
      s = e + 1;
    }
  }
  logger.info('AI', `candidates for ${projectId}: ${valid.length}`);
  return valid;
}

/* ---------------- boundary resolution ---------------- */

/** Map AI segment indices to real timestamps with padding + hard length clamp. */
export function resolveCandidate(raw: CandidateRaw, segments: TranscriptSegment[]): { start: number; end: number; duration: number } {
  const clip = getSettings('clipping');
  const startSeg = segments[raw.start_segment];
  const endSeg = segments[raw.end_segment];
  let start = Math.max(0, startSeg.start - clip.pad_before);
  let end = endSeg.end + clip.pad_after;
  if (end - start > clip.max_clip_duration) end = start + clip.max_clip_duration;
  if (end - start < clip.min_clip_duration) {
    const center = (start + end) / 2;
    start = Math.max(0, center - clip.target_clip_duration / 2);
    end = start + clip.target_clip_duration;
  }
  return { start: round2(start), end: round2(end), duration: round2(end - start) };
}

/* ---------------- scoring ---------------- */

export function normalizeWeights(w: Record<string, unknown>): Record<string, number> {
  const keys = ['hook', 'context', 'standalone', 'emotion', 'entertainment', 'payoff', 'curiosity', 'shareability', 'length'];
  const sum = keys.reduce((a, k) => a + (Number(w[k]) || 0), 0);
  if (sum <= 0) return Object.fromEntries(keys.map((k) => [k, 100 / keys.length]));
  return Object.fromEntries(keys.map((k) => [k, ((Number(w[k]) || 0) / sum) * 100]));
}

export interface ScoreResult {
  scores: Record<string, number>;
  overall_score: number;
  comment: string;
}

export function combineScores(
  factorScores: Record<string, number>,
  duration: number
): ScoreResult {
  const clip = getSettings('clipping');
  const weights = normalizeWeights(getSettings('scoring') as unknown as Record<string, unknown>);
  // Derive a "length" score from how close duration sits to the target window.
  const lengthScore = lengthFitness(duration, clip.min_clip_duration, clip.target_clip_duration, clip.max_clip_duration);
  const all: Record<string, number> = {
    hook: clamp10(factorScores.hook),
    context: clamp10(factorScores.context),
    standalone: clamp10(factorScores.standalone),
    emotion: clamp10(factorScores.emotion),
    entertainment: clamp10(factorScores.entertainment),
    payoff: clamp10(factorScores.payoff),
    curiosity: clamp10(factorScores.curiosity),
    shareability: clamp10(factorScores.shareability),
    length: lengthScore,
  };
  let overall = 0;
  for (const [k, w] of Object.entries(weights)) overall += (all[k] ?? 0) * (w / 100);
  return { scores: all, overall_score: round1(overall * 10), comment: '' };
}

export function lengthFitness(d: number, min: number, target: number, max: number): number {
  if (d >= target) return d <= max ? 10 : Math.max(0, 10 - (d - max) * 0.2);
  if (d >= min) return 6 + 4 * ((d - min) / Math.max(1, target - min));
  return Math.max(0, 6 * (d / Math.max(1, min)));
}

function clamp10(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}
function round1(n: number) { return Math.round(n * 10) / 10; }
function round2(n: number) { return Math.round(n * 100) / 100; }

export async function scoreCandidate(
  transcript: TranscriptData,
  candidate: { start: number; end: number; title: string; duration: number }
): Promise<ScoreResult> {
  const clipTranscript = formatTranscriptForPrompt(transcript.segments, { start: candidate.start, end: candidate.end, maxChars: 8000 });
  const { json } = await generate<Record<string, number> & { comment?: string }>('clip_scoring', {
    clip_transcript: clipTranscript,
    clip_duration: Math.round(candidate.duration),
    title: candidate.title,
    min_clip_duration: getSettings('clipping').min_clip_duration,
    max_clip_duration: getSettings('clipping').max_clip_duration,
  });
  const res = combineScores(json as any, candidate.duration);
  res.comment = typeof json?.comment === 'string' ? json.comment : '';
  return res;
}

/* ---------------- deduplication ---------------- */

/** Overlap ratio = intersection / min(length). Two clips covering the same
 *  span are duplicates even if one is longer. */
export function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const interStart = Math.max(a.start, b.start);
  const interEnd = Math.min(a.end, b.end);
  const inter = Math.max(0, interEnd - interStart);
  const minLen = Math.min(a.end - a.start, b.end - b.start);
  if (minLen <= 0) return 0;
  return inter / minLen;
}

export function deduplicate<T extends { start: number; end: number; overall_score: number }>(
  candidates: T[],
  threshold: number
): T[] {
  const sorted = [...candidates].sort((a, b) => b.overall_score - a.overall_score);
  const kept: T[] = [];
  for (const c of sorted) {
    const dup = kept.some((k) => overlapRatio(c, k) >= threshold);
    if (!dup) kept.push(c);
  }
  return kept;
}
