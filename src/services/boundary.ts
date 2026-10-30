import { getSettings } from '../lib/settings.js';
import { generate } from '../lib/ai.js';
import { formatTranscriptForPrompt, type TranscriptData, type TranscriptSegment } from './transcribe.js';
import { logger } from '../lib/log.js';

/**
 * Refine clip boundaries around real sentence starts/ends using transcript
 * timestamps. We do the mechanical snapping locally (deterministic), then let
 * the AI validate/refine within a small allowed window.
 */

export interface BoundaryResult {
  start: number;
  end: number;
  start_segment: number;
  end_segment: number;
  note: string;
  snapped: boolean;
}

/** Find the nearest segment start at or after `t` (within maxLookahead). */
export function snapStart(segments: TranscriptSegment[], t: number, maxLookahead = 3.0): number {
  let best = t;
  for (const s of segments) {
    if (s.start >= t - 0.05) {
      if (s.start - t <= maxLookahead) best = s.start;
      break;
    }
  }
  return best;
}

/** Find the nearest segment end at or before `t` (within maxLookback). */
export function snapEnd(segments: TranscriptSegment[], t: number, maxLookback = 3.0): number {
  let best = t;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].end <= t + 0.05) {
      if (t - segments[i].end <= maxLookback) best = segments[i].end;
      break;
    }
  }
  return best;
}

export function segmentIndexAt(segments: TranscriptSegment[], t: number): number {
  for (let i = 0; i < segments.length; i++) if (segments[i].start <= t && segments[i].end >= t) return i;
  return segments.findIndex((s) => s.start >= t);
}

export function removeFirstSentence(segments: TranscriptSegment[], start: number): number {
  const idx = segmentIndexAt(segments, start);
  if (idx < 0 || idx + 1 >= segments.length) return start;
  return segments[idx + 1].start;
}

export async function optimizeBoundary(
  transcript: TranscriptData,
  clipStart: number,
  clipEnd: number
): Promise<BoundaryResult> {
  const clip = getSettings('clipping');
  // Deterministic local snap first: never start mid-sentence, never end mid-sentence.
  let start = snapStart(transcript.segments, clipStart - clip.pad_before);
  let end = snapEnd(transcript.segments, clipEnd + clip.pad_after);

  // enforce length window
  start = Math.max(0, start);
  end = Math.min(transcript.duration || end, end);
  if (end - start > clip.max_clip_duration) end = start + clip.max_clip_duration;
  if (end - start < clip.min_clip_duration) {
    end = Math.min(transcript.duration || Infinity, start + clip.target_clip_duration);
    if (end - start < clip.min_clip_duration && start > 0) {
      start = Math.max(0, end - clip.target_clip_duration);
    }
  }

  const startIdx = segmentIndexAt(transcript.segments, start);
  const endIdx = segmentIndexAt(transcript.segments, end - 0.01);

  return {
    start: round2(start),
    end: round2(end),
    start_segment: Math.max(0, startIdx),
    end_segment: Math.max(0, endIdx),
    note: 'snapped to sentence boundaries',
    snapped: true,
  };
}

/** Optional AI refinement within the deterministic window. */
export async function refineBoundaryWithAI(
  transcript: TranscriptData,
  start: number,
  end: number
): Promise<BoundaryResult> {
  const clip = getSettings('clipping');
  const context = formatTranscriptForPrompt(transcript.segments, { start: start - 20, end: end + 20, maxChars: 12000 });
  try {
    const { json } = await generate<{ start: number; end: number; note?: string }>('clip_boundary', {
      context_transcript: context,
      start: start.toFixed(2),
      end: end.toFixed(2),
      min_clip_duration: clip.min_clip_duration,
      max_clip_duration: clip.max_clip_duration,
      start_min: (start - 5).toFixed(2),
      start_max: (start + 5).toFixed(2),
      end_min: (end - 5).toFixed(2),
      end_max: (end + 5).toFixed(2),
    });
    let s = Number(json.start);
    let e = Number(json.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return optimizeBoundary(transcript, start, end);
    // clamp into allowed window, re-snap locally to guarantee sentence alignment
    s = Math.max(start - 5, Math.min(start + 5, s));
    e = Math.max(end - 5, Math.min(end + 5, e));
    s = snapStart(transcript.segments, s);
    e = snapEnd(transcript.segments, e);
    if (e - s < clip.min_clip_duration) e = Math.min(s + clip.target_clip_duration, end + 5);
    if (e - s > clip.max_clip_duration) e = s + clip.max_clip_duration;
    return {
      start: round2(s),
      end: round2(e),
      start_segment: Math.max(0, segmentIndexAt(transcript.segments, s)),
      end_segment: Math.max(0, segmentIndexAt(transcript.segments, e - 0.01)),
      note: json.note || 'AI refined, re-snapped locally',
      snapped: true,
    };
  } catch (err: any) {
    logger.warn('AI', `boundary refinement failed, using local snap: ${String(err?.message).slice(0, 200)}`);
    return optimizeBoundary(transcript, start, end);
  }
}

function round2(n: number) { return Math.round(n * 100) / 100; }
