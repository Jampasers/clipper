import type { TranscriptSegment } from './transcribe.js';

/**
 * Output timeline construction. An optional hook span is *copied* to the very
 * front as a cold-open teaser; the main clip keeps playing in full afterwards
 * (nothing is removed, total duration = clip + hook - transition). The main
 * segment's output span overlaps the hook by HOOK_TRANSITION_SEC so the render
 * graph can crossfade between them instead of hard-cutting.
 */

export const HOOK_TRANSITION_SEC = 0.5;

export interface HookSpan {
  start: number;
  end: number;
}

export interface TimelineSegment {
  role: 'hook' | 'main';
  /** source-absolute times (same clock as transcript + ffprobe) */
  sourceStart: number;
  sourceEnd: number;
  /** output-relative times (what the final file plays) */
  outputStart: number;
  outputEnd: number;
}

export interface TimelinePlan {
  segments: TimelineSegment[];
  outputDuration: number;
  hook: HookSpan | null;
}

export function isHookSpanValid(span: HookSpan | null | undefined, clipStart: number, clipEnd: number, minDuration = 3, maxDuration = 12): boolean {
  if (!span) return false;
  const { start, end } = span;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < clipStart - 0.01 || end > clipEnd + 0.01) return false;
  const d = end - start;
  if (d < minDuration || d > maxDuration) return false;
  // a "hook" covering the whole clip would push the main clip out of existence
  if (end - clipStart >= clipEnd - clipStart - 1.5) return false;
  return true;
}

/** Map a list of candidate source spans in best-first order; returns the first fit. */
/**
 * Build the output timeline from the clip window and an optional hook span.
 * The hook segment is followed by the full clip; the main span starts
 * HOOK_TRANSITION_SEC before the hook ends (crossfade overlap).
 */
export function buildTimeline(clipStart: number, clipEnd: number, hook: HookSpan | null): TimelinePlan {
  const clipDur = Math.max(0, clipEnd - clipStart);
  if (!isHookSpanValid(hook, clipStart, clipEnd) || clipDur < 4) {
    return {
      segments: [{ role: 'main', sourceStart: clipStart, sourceEnd: clipEnd, outputStart: 0, outputEnd: round3(clipDur) }],
      outputDuration: round3(clipDur),
      hook: null,
    };
  }
  const h: HookSpan = { start: Math.max(clipStart, hook!.start), end: Math.min(clipEnd, hook!.end) };
  const hookDur = h.end - h.start;
  const overlap = Math.min(HOOK_TRANSITION_SEC, hookDur / 3);
  const segments: TimelineSegment[] = [
    { role: 'hook', sourceStart: round3(h.start), sourceEnd: round3(h.end), outputStart: 0, outputEnd: round3(hookDur) },
    {
      role: 'main',
      sourceStart: round3(clipStart),
      sourceEnd: round3(clipEnd),
      outputStart: round3(hookDur - overlap),
      outputEnd: round3(hookDur - overlap + clipDur),
    },
  ];
  return { segments, outputDuration: round3(hookDur - overlap + clipDur), hook: h };
}

/** Map a source timestamp to output time (first match wins: times inside the hook map to its teaser copy), or null when off-clip. */
export function mapSourceToOutput(timeline: TimelinePlan, sourceTime: number): number | null {
  for (const seg of timeline.segments) {
    if (sourceTime >= seg.sourceStart - 0.001 && sourceTime <= seg.sourceEnd + 0.001) {
      return seg.outputStart + (sourceTime - seg.sourceStart);
    }
  }
  return null;
}

/** Map an output timestamp back to source time (first matching segment). */
export function mapOutputToSource(timeline: TimelinePlan, outputTime: number): number | null {
  for (const seg of timeline.segments) {
    if (outputTime >= seg.outputStart - 0.001 && outputTime <= seg.outputEnd + 0.001) {
      return seg.sourceStart + (outputTime - seg.outputStart);
    }
  }
  return null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Build subtitle events across the (possibly reordered) timeline. Transcript
 * segments are clipped to each output segment, shifted into output time, and
 * deduplicated; word timing follows along so captions stay frame-accurate.
 */
export interface SubtitleEvent {
  start: number;
  end: number;
  lines: string[];
  words: { text: string; start: number; end: number; style?: unknown }[] | null;
  emphasisWords: string[];
}

export function timelineOutputRanges(timeline: TimelinePlan): { start: number; end: number }[] {
  return timeline.segments.map((s) => ({ start: s.outputStart, end: s.outputEnd }));
}

export function sourceRangeFromOutput(timeline: TimelinePlan): { start: number; end: number } {
  const first = timeline.segments[0];
  const last = timeline.segments[timeline.segments.length - 1];
  return { start: first.sourceStart, end: last.sourceEnd };
}

/**
 * Filter transcript segments to what overlaps any output segment, shifting
 * times per segment. Words are clipped individually so a cut never truncates
 * a caption mid-word visually.
 */
export function clipSegmentsToTimeline(
  segments: TranscriptSegment[],
  timeline: TimelinePlan
): { seg: TranscriptSegment; outStart: number; outEnd: number; oStart: number; oEnd: number }[] {
  const out: { seg: TranscriptSegment; outStart: number; outEnd: number; oStart: number; oEnd: number }[] = [];
  for (const tl of timeline.segments) {
    for (const seg of segments) {
      const s = Math.max(seg.start, tl.sourceStart);
      const e = Math.min(seg.end, tl.sourceEnd);
      if (e - s < 0.05) continue;
      out.push({
        seg,
        outStart: tl.outputStart + (s - tl.sourceStart),
        outEnd: tl.outputStart + (e - tl.sourceStart),
        oStart: s,
        oEnd: e,
      });
    }
  }
  return out;
}
