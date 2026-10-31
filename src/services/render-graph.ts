import type { TimelinePlan } from './timeline.js';
import { cropFilter, type ReframePlan } from './reframe.js';
import type { RenderSettings } from '../lib/settings.js';
import type { WatermarkLayerSpec } from './assets.js';
import { gradeFilters, GRADE_PROFILES } from './adaptive-style.js';
import type { ZoomKey, GradeName, TransitionType } from './edl.js';

/**
 * Deterministic FFmpeg graph construction for the composed render:
 * timeline (hook + main segments) -> crop/fps -> concat -> scale -> [creative:
 * blur-fill / punch-in zoom / color grade / edge fade] -> subtitles
 * -> caption/graphics overlay -> watermarks; audio: trim/concat -> loudnorm
 * -> BGM + SFX mix with speech-aware ducking -> limiter. Single encode, no
 * intermediate files beyond the live Remotion overlays the pipeline produced.
 */

export interface MusicMix {
  inputIndex: number;
  volumeDb: number;
  duckDb: number;
  voiceDucking: boolean;
  fadeIn: number;
  fadeOut: number;
  targetLufs: number;
  duration: number;
}

/** Adaptive creative stage knobs extracted from the validated EDL. */
export interface CreativeRenderSpec {
  /** punch-in / punch-out curve on the OUTPUT timeline */
  zoomKeys: ZoomKey[];
  grade: GradeName;
  backgroundFill: 'crop' | 'fill-blur';
  edgeFade: boolean;
  transition: TransitionType;
  /** voice cleanup + ducking flags from the EDL audio block */
  audio?: { cleanup: boolean; ducking: boolean };
}

/** A resolved b-roll layer on the OUTPUT timeline (asset file + window). */
export interface BrollOverlaySpec {
  /** filled by buildRenderArgs when the input is added */
  inputIndex: number;
  kind: 'video' | 'image';
  path: string;
  start: number;
  end: number;
  mode: 'cover' | 'pip';
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  sizePercent: number;
}

/** A resolved one-shot sound effect on the OUTPUT timeline. */
export interface SfxOverlaySpec {
  /** filled by buildRenderArgs when the input is added */
  inputIndex: number;
  path: string;
  at: number;
  volumeDb: number;
}

export interface RenderGraphSpec {
  clipStart: number;
  timeline: TimelinePlan;
  plan: ReframePlan | null;
  size: { w: number; h: number };
  fps: number;
  assPath: string | null;
  captionInput: number | null;
  watermarks: WatermarkLayerSpec[];
  watermarkInputStart: number;
  musicInput: number | null;
  music: MusicMix | null;
  hasAudio: boolean;
  /** speech windows on the OUTPUT timeline (for ducking) */
  speechRanges: { start: number; end: number }[];
  voiceTargetLufs: number;
  voiceTpDb: number;
  truePeakDb: number;
  /** adaptive creative stages (grade / fill / punch-in / edge fade) */
  creative?: CreativeRenderSpec | null;
  /** resolved b-roll layers (already file-checked by the asset service) */
  broll?: BrollOverlaySpec[];
  /** resolved sfx placements */
  sfx?: SfxOverlaySpec[];
}

export interface RenderGraph {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Merge/sanitize speech windows for the ducking expression. */
export function mergeSpeechRanges(
  ranges: { start: number; end: number }[],
  duration: number,
  gapSec = 0.35,
  minDur = 0.2,
  maxCount = 140
): { start: number; end: number }[] {
  const clamped = ranges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end - r.start >= minDur)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= gapSec) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  // keep the filter expression sane on pathological transcripts
  if (merged.length > maxCount) {
    const kept = merged.filter((_, i) => i % Math.ceil(merged.length / maxCount) === 0);
    return kept;
  }
  return merged;
}

export function duckEnableExpr(ranges: { start: number; end: number }[]): string {
  return ranges.map((r) => `between(t,${round3(r.start)},${round3(r.end)})`).join('+');
}

export function escapeSubtitlePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/* ---------------- watermark positions ---------------- */

export function watermarkPosExpr(position: string, margin: number, custom?: { x: number | null; y: number | null }): { x: string; y: string } {
  const m = Math.max(0, Math.round(margin));
  switch (position) {
    case 'top-left':
      return { x: `${m}`, y: `${m}` };
    case 'top-right':
      return { x: `main_w-overlay_w-${m}`, y: `${m}` };
    case 'bottom-left':
      return { x: `${m}`, y: `main_h-overlay_h-${m}` };
    case 'center':
      return { x: `(main_w-overlay_w)/2`, y: `(main_h-overlay_h)/2` };
    case 'custom':
      return {
        x: `min(max(0\\,${Math.round(custom?.x ?? 0)})\\,main_w-overlay_w)`,
        y: `min(max(0\\,${Math.round(custom?.y ?? 0)})\\,main_h-overlay_h)`,
      };
    case 'bottom-right':
    default:
      return { x: `main_w-overlay_w-${m}`, y: `main_h-overlay_h-${m}` };
  }
}

/** Piecewise-linear zoom expression (matches edl.zoomAt); null when flat at 1. */
export function zoomExprFromKeys(keys: ZoomKey[]): string | null {
  if (!keys.length || keys.every((k) => Math.abs(k.z - 1) < 0.001)) return null;
  let expr = keys[keys.length - 1].z.toFixed(4);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i];
    const b = keys[i + 1];
    const span = Math.max(0.001, b.t - a.t);
    const lerp = `(${a.z.toFixed(4)}+(${b.z.toFixed(4)}-${a.z.toFixed(4)})*(t-${a.t.toFixed(3)})/${span.toFixed(3)})`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${lerp},${expr})`;
  }
  return expr.replace(/,/g, '\\,');
}

/* ---------------- filter graph ---------------- */

export function buildRenderGraph(spec: RenderGraphSpec): RenderGraph {
  const parts: string[] = [];
  const segs = spec.timeline.segments;
  const n = segs.length;
  const creative = spec.creative ?? null;
  const fillBlur = creative?.backgroundFill === 'fill-blur';

  /** crop (unless blur-fill) -> fps -> setsar, applied once per segment input (each input is already trimmed by -ss/-t) */
  const preFor = (i: number): string[] => {
    const out: string[] = [];
    if (
      !fillBlur &&
      spec.plan &&
      spec.plan.cropW > 0 &&
      spec.plan.cropH > 0 &&
      (spec.plan.cropW !== spec.size.w || spec.plan.cropH !== spec.size.h)
    ) {
      // keyframes are clip-relative but a seeked input restarts at t=0, so the
      // pan expression gets this segment's source offset as its clock
      const { x } = cropFilter(spec.plan, spec.size, round3(segs[i].sourceStart - spec.clipStart));
      out.push(`crop=${spec.plan.cropW}:${spec.plan.cropH}:${x}:0`);
    }
    out.push(`fps=${spec.fps}`, `setsar=1`);
    return out;
  };

  if (n <= 1) {
    parts.push(`[0:v]${preFor(0).join(',')},scale=${spec.size.w}:${spec.size.h}[vbase]`);
  } else {
    // one input per timeline segment: -ss/-t seek per segment avoids buffering the
    // whole seeked window in a split filter (large-clip memory blowup)
    segs.forEach((_, i) => parts.push(`[${i}:v]${preFor(i).join(',')}[s${i}]`));
    // ponytail: only the hook->main boundary exists today; its overlap gets a
    // crossfade instead of a hard cut. Generalize the fold if segments ever grow.
    const overlap = round3(segs[n - 2].outputEnd - segs[n - 1].outputStart);
    const tail = `,scale=${spec.size.w}:${spec.size.h}`;
    if (n === 2 && overlap > 0.01) {
      const transition = creative?.transition === 'slide' ? 'slideleft' : 'fade';
      parts.push(`[s0][s1]xfade=transition=${transition}:duration=${overlap}:offset=${round3(segs[1].outputStart)}${tail}[vbase]`);
    } else {
      const inLabels = segs.map((_, i) => `[s${i}]`).join('');
      parts.push(`${inLabels}concat=n=${n}:v=1:a=0${tail}[vbase]`);
    }
  }

  let curLabel = 'vbase';

  /* ---- creative stage: blur-fill background ---- */
  if (fillBlur) {
    const W = spec.size.w;
    const H = spec.size.h;
    parts.push(`[${curLabel}]split=2[vfit0][vblur0]`);
    parts.push(`[vfit0]scale=${W}:${H}:force_original_aspect_ratio=decrease[vfit]`);
    parts.push(`[vblur0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=24,eq=brightness=-0.06:saturation=0.9[vbg]`);
    parts.push(`[vbg][vfit]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[vc]`);
    curLabel = 'vc';
  }

  /* ---- creative stage: punch-in zoom on the OUTPUT timeline ---- */
  if (creative) {
    const zoom = zoomExprFromKeys(creative.zoomKeys);
    if (zoom) {
      const W = spec.size.w;
      const H = spec.size.h;
      parts.push(
        `[${curLabel}]scale=w=trunc(iw*(${zoom})/2)*2:h=trunc(ih*(${zoom})/2)*2:eval=frame,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2[vz]`
      );
      curLabel = 'vz';
    }
  }

  /* ---- creative stage: color grade ---- */
  if (creative && creative.grade !== 'none') {
    const gf = gradeFilters(GRADE_PROFILES[creative.grade]);
    if (gf.length) {
      parts.push(`[${curLabel}]${gf.join(',')}[vgrade]`);
      curLabel = 'vgrade';
    }
  }

  /* ---- creative stage: edge fades ---- */
  if (creative?.edgeFade) {
    const dur = spec.timeline.outputDuration;
    const d = round3(Math.min(0.6, dur / 6));
    parts.push(`[${curLabel}]fade=t=in:st=0:d=${d},fade=t=out:st=${round3(Math.max(0, dur - d))}:d=${d}[vfade]`);
    curLabel = 'vfade';
  }

  /* ---- creative stage: b-roll layers (below subtitles/graphics) ---- */
  const W = spec.size.w;
  const H = spec.size.h;
  (spec.broll ?? []).forEach((b, k) => {
    const d = round3(Math.max(0.2, b.end - b.start));
    const fade = round3(Math.min(0.35, d / 4));
    const layer = [`[${b.inputIndex}:v]fps=${spec.fps}`, 'setsar=1'];
    if (b.mode === 'pip') {
      const pct = Math.min(60, Math.max(15, b.sizePercent));
      const w = Math.max(60, Math.round((W * pct) / 100));
      layer.push(`scale=${w}:-2`);
    } else {
      layer.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
    }
    // the broll stream clock matches the main clock (both start at 0), so the
    // alpha fades use the absolute window times directly
    layer.push('format=yuva420p', `fade=t=in:st=${round3(b.start)}:d=${fade}:alpha=1`, `fade=t=out:st=${round3(b.start + d - fade)}:d=${fade}:alpha=1`);
    parts.push(layer.join(',') + `[brf${k}]`);
    const pos = b.mode === 'pip' ? watermarkPosExpr(b.position, 24) : { x: '0', y: '0' };
    parts.push(
      `[${curLabel}][brf${k}]overlay=x='${pos.x}':y='${pos.y}':format=auto:enable='between(t,${round3(b.start)},${round3(b.start + d)})'[bro${k}]`
    );
    curLabel = `bro${k}`;
  });

  if (spec.assPath) {
    parts.push(`[${curLabel}]subtitles='${escapeSubtitlePath(spec.assPath)}'[vtxt]`);
    curLabel = 'vtxt';
  }

  if (spec.captionInput !== null) {
    parts.push(`[${curLabel}][${spec.captionInput}:v]overlay=0:0:format=auto[vcap]`);
    curLabel = 'vcap';
  }

  spec.watermarks.forEach((wm, i) => {
    const inputIdx = spec.watermarkInputStart + i;
    const scaledW = Math.max(8, Math.round((spec.size.w * wm.widthPercent) / 100));
    parts.push(`[${inputIdx}:v]scale=${scaledW}:-1,format=rgba,colorchannelmixer=aa=${clamp01(wm.opacity)}[wmf${i}]`);
    const pos = watermarkPosExpr(wm.position, wm.margin, { x: wm.x, y: wm.y });
    parts.push(`[${curLabel}][wmf${i}]overlay=x='${pos.x}':y='${pos.y}':format=auto[wm${i}]`);
    curLabel = `wm${i}`;
  });

  /* ---- audio ---- */
  let audioLabel: string | null = null;
  if (spec.hasAudio) {
    if (n <= 1) {
      parts.push(`[0:a]asetpts=PTS-STARTPTS[voiceRaw]`);
    } else {
      segs.forEach((_, i) => parts.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`));
      const overlap = round3(segs[n - 2].outputEnd - segs[n - 1].outputStart);
      if (n === 2 && overlap > 0.01) {
        parts.push(`[a0][a1]acrossfade=d=${overlap}:c1=tri:c2=tri[voiceRaw]`);
      } else {
        const segIn = segs.map((_, i) => `[a${i}]`).join('');
        parts.push(`${segIn}concat=n=${n}:v=0:a=1[voiceRaw]`);
      }
    }
    const cleanup = creative?.audio?.cleanup ? 'highpass=f=80,afftdn=nr=12:nf=-35,' : '';
    parts.push(`[voiceRaw]${cleanup}loudnorm=I=${round3(spec.voiceTargetLufs)}:TP=${round3(spec.voiceTpDb)}:LRA=11,aresample=48000[voice]`);
  }

  const limiterGain = Math.pow(10, spec.truePeakDb / 20).toFixed(4);
  const mixInputs: string[] = [];
  if (spec.hasAudio) mixInputs.push('[voice]');

  if (spec.musicInput !== null && spec.music) {
    const mu = spec.music;
    const musicParts = [
      `[${spec.musicInput}:a]atrim=0:${round3(mu.duration)},asetpts=PTS-STARTPTS`,
      `loudnorm=I=${round3(mu.targetLufs)}:TP=-2:LRA=11`,
    ];
    if (mu.volumeDb !== 0) musicParts.push(`volume=${round3(mu.volumeDb)}dB`);
    if (spec.hasAudio && mu.voiceDucking) {
      const ranges = mergeSpeechRanges(spec.speechRanges, mu.duration);
      if (ranges.length) {
        const gain = Math.pow(10, -mu.duckDb / 20).toFixed(4);
        musicParts.push(`volume=${gain}:enable='${duckEnableExpr(ranges)}'`);
      }
    }
    if (mu.fadeIn > 0) musicParts.push(`afade=t=in:st=0:d=${round3(Math.min(mu.fadeIn, mu.duration))}`);
    if (mu.fadeOut > 0) {
      const st = Math.max(0, mu.duration - mu.fadeOut);
      musicParts.push(`afade=t=out:st=${round3(st)}:d=${round3(Math.min(mu.fadeOut, mu.duration - st))}`);
    }
    musicParts.push('aresample=48000');
    parts.push(musicParts.join(',') + '[bgm]');
    mixInputs.push('[bgm]');
  }

  (spec.sfx ?? []).forEach((s, k) => {
    const chain = [`[${s.inputIndex}:a]adelay=${Math.round(Math.max(0, s.at) * 1000)}:all=1`];
    if (s.volumeDb !== 0) chain.push(`volume=${round3(s.volumeDb)}dB`);
    parts.push(chain.join(',') + ',aresample=48000' + `[sfx${k}]`);
    mixInputs.push(`[sfx${k}]`);
  });

  if (mixInputs.length === 1) {
    parts.push(`${mixInputs[0]}alimiter=limit=${limiterGain}[aud]`);
    audioLabel = '[aud]';
  } else if (mixInputs.length > 1) {
    parts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:normalize=0,alimiter=limit=${limiterGain}[aud]`);
    audioLabel = '[aud]';
  } else {
    audioLabel = null; // -an
  }

  return { filterComplex: parts.join(';'), videoLabel: `[${curLabel}]`, audioLabel };
}

function clamp01(n: unknown): number {
  const v = Number(n);
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
}

/* ---------------- full argument assembly ---------------- */

export interface RenderArgsSpec extends Omit<RenderGraphSpec, 'captionInput' | 'musicInput' | 'watermarkInputStart' | 'broll' | 'sfx'> {
  source: string;
  output: string;
  outputDuration: number;
  rs: RenderSettings;
  musicPath: string | null;
  captionPath: string | null;
  broll?: Omit<BrollOverlaySpec, 'inputIndex'>[];
  sfx?: Omit<SfxOverlaySpec, 'inputIndex'>[];
}

/** Assemble one-pass ffmpeg args for the composed render. Audio/video codec settings mirror buildFfmpegArgs. */
export function buildRenderArgs(spec: RenderArgsSpec): string[] {
  const rs = spec.rs;
  const args: string[] = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats'];
  for (const seg of spec.timeline.segments) {
    args.push('-ss', round3(seg.sourceStart).toFixed(3), '-t', round3(Math.max(0.1, seg.sourceEnd - seg.sourceStart)).toFixed(3), '-i', spec.source);
  }

  let inputIndex = spec.timeline.segments.length;
  for (const wm of spec.watermarks) {
    inputIndex++;
    args.push('-i', wm.asset.file_path);
  }
  let musicIndex: number | null = null;
  if (spec.musicPath) {
    musicIndex = inputIndex++;
    args.push('-stream_loop', '-1', '-i', spec.musicPath);
  }
  let captionIndex: number | null = null;
  if (spec.captionPath) {
    captionIndex = inputIndex++;
    args.push('-i', spec.captionPath);
  }

  const brollInputs: BrollOverlaySpec[] = [];
  for (const b of spec.broll ?? []) {
    const graphIndex = inputIndex++;
    if (b.kind === 'image') args.push('-loop', '1', '-t', round3(b.end - b.start + 0.5).toFixed(3));
    else args.push('-t', round3(b.end - b.start + 0.4).toFixed(3));
    args.push('-i', b.path);
    brollInputs.push({ ...b, inputIndex: graphIndex });
  }
  const sfxInputs: SfxOverlaySpec[] = [];
  for (const s of spec.sfx ?? []) {
    const graphIndex = inputIndex++;
    args.push('-i', s.path);
    sfxInputs.push({ ...s, inputIndex: graphIndex });
  }

  const graphSpec: RenderGraphSpec = {
    ...spec,
    captionInput: captionIndex,
    musicInput: musicIndex,
    watermarkInputStart: spec.timeline.segments.length,
    music: spec.music ? { ...spec.music, inputIndex: musicIndex ?? -1 } : null,
    broll: brollInputs,
    sfx: sfxInputs,
  };
  const graph = buildRenderGraph(graphSpec);

  args.push('-t', round3(spec.outputDuration).toFixed(3));
  args.push('-filter_complex', graph.filterComplex);
  args.push('-map', graph.videoLabel);
  if (graph.audioLabel) {
    args.push('-map', graph.audioLabel);
    args.push('-c:a', rs.acodec, '-b:a', rs.audio_bitrate, '-ar', '48000');
  } else {
    args.push('-an');
  }
  args.push('-c:v', rs.vcodec);
  if (rs.bitrate) args.push('-b:v', rs.bitrate);
  else args.push('-crf', String(rs.crf));
  args.push('-preset', rs.preset, '-pix_fmt', rs.pixel_format, '-movflags', '+faststart');
  args.push(spec.output);
  return args;
}
