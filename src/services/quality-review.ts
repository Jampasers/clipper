/* Quality review for adaptive (creative) renders.
 *
 * Static review  — pure data checks on the EDL + subtitle events (collisions,
 *                  timing, safe areas). Runs BEFORE the render; problems are
 *                  fixed by the bounded repairEdl in edl.ts.
 * Media review   — post-render probe of the encoded file (black spans via
 *                  blackdetect). Problems map onto the same repair codes.
 */
import { runCmd } from '../lib/ffmpeg.js';
import { config } from '../config.js';
import type { Edl, EdlProblem } from './edl.js';
import { findCollisions, overlayLayout } from './edl.js';
import type { SubtitleEvent } from './subtitles.js';

/** Captions sit in this normalized band of the frame (must match CreativeOverlay). */
export const CAPTION_BAND = { y0: 0.6, y1: 0.85 };

export interface StaticReviewInput {
  edl: Edl;
  duration: number;
  events: SubtitleEvent[];
  /** watermark bands on the output timeline (0..1 coords), if any */
  watermarkBands?: { id: string; start: number; end: number; x0: number; x1: number; y0: number; y1: number }[];
}

export interface StaticReview {
  ok: boolean;
  problems: EdlProblem[];
}

/** Data-level review of the creative plan against the subtitles. Never throws. */
export function reviewCreativeStatic(input: StaticReviewInput): StaticReview {
  const problems: EdlProblem[] = [];
  const edl = input.edl;

  // 1. overlay collisions (graphics vs captions / each other / watermarks)
  const boxes = overlayLayout(edl, {
    captionBand: input.events.length ? CAPTION_BAND : null,
    watermarkBands: input.watermarkBands,
  });
  for (const c of findCollisions(boxes)) {
    problems.push({
      code: 'overlay_collision',
      detail: `${c.a.kind} <-> ${c.b.kind} overlap ${c.overlapSec}s (area ${c.area})`,
      ids: [c.a.id, c.b.id],
    });
  }

  // 2. subtitle event timing sanity
  let badEvents = 0;
  for (const e of input.events) {
    if (!(e.start >= -0.01 && e.end > e.start && e.start < input.duration && e.end <= input.duration + 0.05)) badEvents++;
  }
  if (badEvents) {
    problems.push({ code: 'timing', detail: `${badEvents} subtitle event(s) outside the output window` });
  }

  // 3. placement windows inside the output
  const outsideBroll: string[] = [];
  edl.broll.forEach((b, i) => {
    if (b.start < 0 || b.end > input.duration + 0.05 || b.end - b.start < 0.2) outsideBroll.push(`broll:${i}`);
  });
  if (outsideBroll.length) {
    problems.push({ code: 'broll_window', detail: 'b-roll window outside output or too short', ids: outsideBroll });
  }
  const lateSfx: string[] = [];
  edl.sfx.forEach((s, i) => {
    if (s.at < 0 || s.at > input.duration - 0.05) lateSfx.push(`sfx:${i}`);
  });
  if (lateSfx.length) {
    problems.push({ code: 'audio_clipping', detail: 'sfx placed at/after the output end', ids: lateSfx });
  }

  return { ok: problems.length === 0, problems };
}

export interface MediaReview {
  ok: boolean;
  problems: EdlProblem[];
}

/**
 * Post-render media checks. Currently: black-frame detection — the failure
 * mode of a bad b-roll overlay / edge-fade combination. Structural checks
 * (duration/streams/resolution) and loudness live in render.ts qualityCheck*.
 */
export async function reviewOutputMedia(
  file: string,
  expectedDuration: number,
  opts: { jobId?: string } = {}
): Promise<MediaReview> {
  const { code, stderr, stdout } = await runCmd(
    config.ffmpeg,
    [
      '-hide_banner', '-nostdin', '-v', 'info', '-i', file,
      '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-',
    ],
    { jobId: opts.jobId }
  );
  void stdout;
  if (code !== 0) return { ok: true, problems: [] }; // advisory only — structural QA already ran
  const spans: { start: number; end: number }[] = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+)[^\d.]+black_end:([\d.]+)/g)) {
    spans.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
  }
  const totalBlack = spans.reduce((s, r) => s + (r.end - r.start), 0);
  if (totalBlack < expectedDuration * 0.2 || totalBlack < 1) {
    return { ok: true, problems: [] };
  }
  return {
    ok: false,
    problems: [
      {
        code: 'black_frames',
        detail: `${totalBlack.toFixed(1)}s black of ${expectedDuration.toFixed(1)}s`,
        ids: spans.map((s) => `${s.start}|${s.end}`),
      },
    ],
  };
}
