import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { getSettings, type RenderSettings, type SubtitlePreset } from '../lib/settings.js';
import { runCmd, parseProgressTime, probeVideo, type MediaProbe } from '../lib/ffmpeg.js';
import { cropFilter, type ReframePlan } from './reframe.js';
import { buildSubtitleEvents, writeSubtitleFiles } from './subtitles.js';
import type { TranscriptSegment } from './transcribe.js';
import { logger } from '../lib/log.js';

export type RenderKind = 'preview' | 'final' | 'telegram';

export interface RenderResult {
  output: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  subtitles: { srt: string; ass: string } | null;
  reframe: { usedTracking: boolean; aspect: string };
}

export interface RenderRequest {
  clip: { id: string; start: number; end: number; aspect?: string | null; subtitle_preset?: string | null };
  sourcePath: string;
  probe: MediaProbe;
  kind: RenderKind;
  transcript: TranscriptSegment[] | null;
  emphasisWords?: string[];
  onProgress?: (p: number) => void;
}

export function clipOutputName(clipId: string, kind: RenderKind): string {
  return `${clipId}_${kind}.mp4`;
}

export function outputDir(kind: RenderKind): string {
  return kind === 'preview' ? config.dirs.preview : config.dirs.output;
}

export function existingOutput(clipId: string, kind: RenderKind): string | null {
  const p = path.join(outputDir(kind), clipOutputName(clipId, kind));
  return fs.existsSync(p) ? p : null;
}

/* ---------------- geometry ---------------- */

export function targetSize(aspect: '9:16' | '1:1' | '16:9', rs: RenderSettings): { w: number; h: number } {
  if (aspect === '9:16') return { w: rs.width, h: rs.height };
  if (aspect === '16:9') return { w: rs.height, h: rs.width };
  return { w: Math.round((rs.height * 1) / 2) * 2, h: rs.height };
}

/** Preview keeps the clip's aspect but scales down to the preview height. */
export function previewSize(full: { w: number; h: number }, rs: RenderSettings): { w: number; h: number } {
  const k = rs.preview_height / full.h;
  return { w: Math.round((full.w * k) / 2) * 2, h: Math.round((full.h * k) / 2) * 2 };
}

/** Static (no-tracking) crop geometry so even a plain crop refit is deterministic. */
export function staticPlan(aspect: '9:16' | '1:1' | '16:9', probe: MediaProbe): ReframePlan {
  let cropW = probe.width;
  let cropH = probe.height;
  const srcAR = probe.width / Math.max(1, probe.height);
  const ratios = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
  const targetAR = ratios[aspect];
  if (aspect !== '16:9') {
    cropH = probe.height;
    cropW = Math.min(probe.width, Math.round(probe.height * targetAR));
    if (probe.width - cropW < 4) cropW = probe.width; // already narrower than target
  } else if (srcAR < targetAR - 0.02) {
    cropW = probe.width;
    cropH = Math.min(probe.height, Math.round(probe.width / targetAR));
  }
  const cx = cropW < probe.width ? probe.width / 2 : 0;
  return { aspect, cropW, cropH, frames: [{ t: 0, cx }], usedTracking: false };
}

/* ---------------- filter graph ---------------- */

export function buildFilters(plan: ReframePlan | null, size: { w: number; h: number }, fps: number, assPath: string | null): string {
  const filters: string[] = [];
  if (plan && plan.cropW > 0 && plan.cropH > 0 && (plan.cropW !== size.w || plan.cropH !== size.h)) {
    const { x } = cropFilter(plan, size);
    filters.push(`crop=${plan.cropW}:${plan.cropH}:${x}:0`);
  }
  filters.push(`fps=${fps}`, `scale=${size.w}:${size.h}`, 'setsar=1');
  if (assPath) {
    const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filters.push(`subtitles='${escaped}'`);
  }
  return filters.join(',');
}

export function buildFfmpegArgs(opts: {
  source: string;
  start: number;
  duration: number;
  filters: string;
  overlayPath?: string | null;
  rs: RenderSettings;
  hasAudio: boolean;
  output: string;
}): string[] {
  const rs = opts.rs;
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats',
    '-ss', opts.start.toFixed(3), '-i', opts.source,
  ];
  if (opts.overlayPath) args.push('-i', opts.overlayPath);
  args.push('-t', opts.duration.toFixed(3));
  if (opts.overlayPath) {
    args.push(
      '-filter_complex', `[0:v]${opts.filters}[base];[base][1:v]overlay=0:0:format=auto[v]`,
      '-map', '[v]',
    );
    if (opts.hasAudio) args.push('-map', '0:a?');
  } else {
    args.push('-vf', opts.filters);
  }
  args.push('-c:v', rs.vcodec);
  if (rs.bitrate) args.push('-b:v', rs.bitrate);
  else args.push('-crf', String(rs.crf));
  if (opts.hasAudio) args.push('-c:a', rs.acodec, '-b:a', rs.audio_bitrate);
  else args.push('-an');
  args.push('-preset', rs.preset, '-pix_fmt', rs.pixel_format, '-movflags', '+faststart');
  args.push(opts.output);
  return args;
}

/* ---------------- main entry ---------------- */

export async function renderClip(req: RenderRequest): Promise<RenderResult> {
  const rs = getSettings('render');
  const rf = getSettings('reframe');
  const sub = getSettings('subtitles');
  const clip = req.clip;
  const aspect = ((clip.aspect as '9:16' | '1:1' | '16:9') || rf.aspect) as '9:16' | '1:1' | '16:9';
  const dir = outputDir(req.kind);
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, clipOutputName(clip.id, req.kind));
  const tmpOut = `${output}.part.mp4`;
  try { if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut, { force: true }); } catch {}

  req.onProgress?.(3);

  // 1. reframe
  let plan: ReframePlan;
  if (rf.face_tracking && req.probe.width && req.probe.height) {
    // speech windows (from the already-computed transcript) tell the tracker
    // when someone is talking — without them it cannot tell speaker from listener
    const speech = (req.transcript ?? [])
      .filter((s) => s.end > clip.start && s.start < clip.end)
      .map((s) => ({ start: Math.max(s.start, clip.start), end: Math.min(s.end, clip.end) }));
    const { planReframe } = await import('./reframe.js');
    plan = await planReframe(req.sourcePath, req.probe.width, req.probe.height, clip.start, clip.end, aspect, speech);
  } else {
    plan = staticPlan(aspect, req.probe);
  }
  req.onProgress?.(25);

  // 2. subtitles
  let files: { srt: string; ass: string; preset: SubtitlePreset } | null = null;
  let overlayPath: string | null = null;
  const full = targetSize(aspect, rs);
  const size = req.kind === 'preview'
    ? previewSize(full, rs)
    : full;
  if (sub.enabled && req.transcript && req.transcript.length) {
    const events = buildSubtitleEvents(req.transcript, clip.start, clip.end, resolvePreset(clip.subtitle_preset));
    if (req.emphasisWords && req.emphasisWords.length) {
      const { withEmphasis } = await import('./subtitles.js');
      withEmphasis(events, req.emphasisWords);
    }
    files = writeSubtitleFiles(clip.id, events, clip.subtitle_preset || sub.preset, size);
    req.onProgress?.(35);
    if ((sub.engine ?? 'remotion') === 'remotion') {
      const { renderCaptionOverlay } = await import('./caption-render.js');
      overlayPath = await renderCaptionOverlay({
        clipId: clip.id, events, preset: files.preset, emphasis: sub.emphasis,
        width: size.w, height: size.h, fps: rs.fps, durationSec: clip.end - clip.start,
      });
      req.onProgress?.(45);
    }
  }

  // 3. encode
  const filters = buildFilters(plan, size, rs.fps, overlayPath ? null : (files?.ass ?? null));
  const args = buildFfmpegArgs({
    source: req.sourcePath,
    start: clip.start,
    duration: clip.end - clip.start,
    filters,
    overlayPath,
    rs,
    hasAudio: req.probe.hasAudio,
    output: tmpOut,
  });
  const t0 = Date.now();
  const { code, stderr } = await runCmd(config.ffmpeg, args, {
    onStdout: (line) => {
      const t = parseProgressTime(line);
      if (t !== null) {
        const total = Math.max(0.1, clip.end - clip.start);
        req.onProgress?.(Math.min(95, 45 + Math.round((t / total) * 50)));
      }
    },
  });
  if (code !== 0) {
    try { fs.rmSync(tmpOut, { force: true }); } catch {}
    throw new Error(`ffmpeg exit ${code}: ${tail(stderr, 600)}`);
  }
  const stat = fs.statSync(tmpOut);
  if (stat.size < 10000) {
    try { fs.rmSync(tmpOut, { force: true }); } catch {}
    throw new Error('ffmpeg produced a suspiciously small file');
  }
  fs.renameSync(tmpOut, output);
  if (overlayPath) try { fs.rmSync(overlayPath, { force: true }); } catch {}
  logger.info('RENDER', `${clip.id} ${req.kind} -> ${path.basename(output)} (${(stat.size / 1e6).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  req.onProgress?.(97);

  // 4. QA
  const out = await probeVideo(output);
  await qualityCheck(output, out, {
    expectedDuration: clip.end - clip.start,
    size,
    needAudio: req.probe.hasAudio,
    kinds: req.kind,
    files,
  });
  req.onProgress?.(100);

  return {
    output,
    duration: out.duration,
    width: out.width,
    height: out.height,
    size: stat.size,
    subtitles: files,
    reframe: { usedTracking: plan.usedTracking, aspect },
  };
}

function resolvePreset(name?: string | null): SubtitlePreset {
  const sub = getSettings('subtitles');
  const presets = Object.values(sub.presets);
  return sub.presets[name ?? ''] ?? sub.presets[sub.preset] ?? presets[0];
}

/* ---------------- QA ---------------- */

export async function qualityCheck(
  file: string,
  probe: { duration: number; width: number; height: number; hasAudio: boolean; hasVideo: boolean },
  expect: { expectedDuration: number; size: { w: number; h: number }; needAudio: boolean; kinds: RenderKind; files: { srt: string; ass: string } | null }
): Promise<void> {
  const problems: string[] = [];
  if (!fs.existsSync(file)) problems.push('output file missing');
  if (!probe.hasVideo) problems.push('no video stream');
  if (probe.duration < 0.5 || Math.abs(probe.duration - expect.expectedDuration) > 2.5) {
    problems.push(`duration ${probe.duration.toFixed(2)}s, expected ~${expect.expectedDuration.toFixed(2)}s`);
  }
  if (expect.needAudio && !probe.hasAudio) problems.push('missing audio stream');
  const wOk = Math.abs(probe.width - expect.size.w) <= 16;
  const hOk = Math.abs(probe.height - expect.size.h) <= 16;
  if (!wOk || !hOk) problems.push(`resolution ${probe.width}x${probe.height}, expected ${expect.size.w}x${expect.size.h}`);
  const stat = fs.statSync(file);
  if (stat.size < 20000) problems.push(`file too small (${stat.size}B)`);
  if (expect.files && !fs.existsSync(expect.files.ass)) problems.push('subtitle file missing while burned-in subs enabled');
  // visual sanity: sample a middle frame and ensure it is not black/empty
  const frame = path.join(config.dirs.temp, `${path.basename(file)}.qa.jpg`);
  const { code, stderr } = await runCmd(config.ffmpeg, [
    '-y', '-v', 'error', '-ss', (probe.duration / 2).toFixed(2), '-i', file, '-frames:v', '1', frame,
  ], {});
  if (code !== 0 || !fs.existsSync(frame)) {
    problems.push(`could not extract sanity frame: ${tail(stderr, 200)}`);
  } else if (fs.statSync(frame).size < 3000) {
    problems.push('sanity frame looks blank (<3KB)');
  }
  fs.rmSync(frame, { force: true });
  if (problems.length) throw new Error(`QA failed: ${problems.join('; ')}`);
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}
