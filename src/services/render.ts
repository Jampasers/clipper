import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { getSettings, type RenderSettings, type SubtitlePreset } from '../lib/settings.js';
import { runCmd, parseProgressTime, probeVideo, type MediaProbe } from '../lib/ffmpeg.js';
import { cropFilter, type ReframePlan } from './reframe.js';
import { buildTimelineSubtitleEvents, writeSubtitleFiles, type SubtitleEvent } from './subtitles.js';
import type { TranscriptSegment, TranscriptData } from './transcribe.js';
import { logger } from '../lib/log.js';
import { defaultRenderOptions, type RenderOptions } from './render-options.js';
import { getOrCreateEditingPlan, type EditingPlan } from './editing-plan.js';
import { collectClipWords, resolveWordStyles, annotateTranscript } from './subtitle-plan.js';
import type { TimelinePlan } from './timeline.js';
import { resolveMusicFile } from './music.js';
import { resolveWatermarkLayers } from './assets.js';
import { buildRenderArgs, type MusicMix, type BrollOverlaySpec, type SfxOverlaySpec } from './render-graph.js';
import { buildZoomKeys, repairEdl, validateEdl, type Edl } from './edl.js';
import { resolveBrollPlacements } from './broll.js';
import { resolveSfxPlacements } from './sfx.js';
import { reviewCreativeStatic, reviewOutputMedia } from './quality-review.js';

export type RenderKind = 'preview' | 'final' | 'telegram';

export interface RenderResult {
  output: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  subtitles: { srt: string; ass: string } | null;
  reframe: { usedTracking: boolean; aspect: string };
  /** human-readable summary of what the editing plan produced */
  summary: {
    hook: boolean;
    hookSource: 'ai' | 'fallback' | 'none';
    music: string | null;
    musicSource: string | null;
    subtitleSource: string | null;
    watermarkCount: number;
    optionsHash: string;
    creativeMode: 'basic' | 'adaptive';
    creativeSource: 'ai' | 'fallback' | null;
    qualityRepair: string[];
    qualityIssues: string[];
  };
}

export interface RenderRequest {
  clip: { id: string; start: number; end: number; aspect?: string | null; subtitle_preset?: string | null; title?: string | null };
  sourcePath: string;
  probe: MediaProbe;
  kind: RenderKind;
  transcript: TranscriptSegment[] | null;
  /** resolved per-job options; defaults when omitted */
  options?: RenderOptions;
  /** prebuilt editing plan (pipeline builds/caches it); built here when omitted */
  plan?: EditingPlan | null;
  jobId?: string;
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

/* ---------------- filter graph (legacy single-pass helpers, kept for tests) ---------------- */

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
  const musicSettings = getSettings('music');
  const options = req.options ?? defaultRenderOptions();
  const clip = req.clip;
  const aspect = ((options.aspect ?? clip.aspect ?? rf.aspect) as '9:16' | '1:1' | '16:9');
  const dir = outputDir(req.kind);
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, clipOutputName(clip.id, req.kind));
  const tmpOut = `${output}.part.mp4`;
  try { if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut, { force: true }); } catch {}

  req.onProgress?.(3);

  // 1. editing plan (hook + timeline + subtitle styles + music choice), cached per clip+options
  const transcriptData: TranscriptData | null = req.transcript
    ? {
        model: '',
        language: '',
        duration: req.probe.duration,
        segments: req.transcript,
        text: req.transcript.map((s) => s.text).join(' '),
      }
    : null;
  const plan =
    req.plan ??
    (await getOrCreateEditingPlan({
      clipId: clip.id,
      clipStart: clip.start,
      clipEnd: clip.end,
      title: clip.title ?? null,
      transcript: transcriptData,
      options,
      aspect,
      sourcePath: req.sourcePath,
      probe: req.probe,
    }));
  const timeline: TimelinePlan = plan.timeline;
  const outputDuration = timeline.outputDuration;
  req.onProgress?.(15);

  // adaptive creative plan (EDL) — null in basic mode or when the plan failed
  const creative = options.creative?.mode === 'adaptive' ? plan.creative : null;
  let creativeEdl: Edl | null = creative;

  // 2. reframe
  let framePlan: ReframePlan;
  if (rf.face_tracking && req.probe.width && req.probe.height) {
    // speech windows (from the already-computed transcript) tell the tracker
    // when someone is talking — without them it cannot tell speaker from listener
    const speech = (req.transcript ?? [])
      .filter((s) => s.end > clip.start && s.start < clip.end)
      .map((s) => ({ start: Math.max(s.start, clip.start), end: Math.min(s.end, clip.end) }));
    const { planReframe } = await import('./reframe.js');
    framePlan = await planReframe(req.sourcePath, req.probe.width, req.probe.height, clip.start, clip.end, aspect, speech);
  } else {
    framePlan = staticPlan(aspect, req.probe);
  }
  req.onProgress?.(25);

  // 3. subtitles over the output timeline (hook reordering included)
  let files: { srt: string; ass: string; preset: SubtitlePreset } | null = null;
  let overlayPath: string | null = null;
  const full = targetSize(aspect, rs);
  const size = req.kind === 'preview' ? previewSize(full, rs) : full;
  let subtitleSource: string | null = null;
  let events: SubtitleEvent[] = [];
  let presetName: string | undefined;
  let preset: SubtitlePreset = resolvePreset(undefined);
  if (options.subtitles.enabled && req.transcript && req.transcript.length) {
    const clipWords = collectClipWords(req.transcript, clip.start, clip.end);
    const styles = resolveWordStyles(plan.subtitle?.words ?? null, {
      style: options.subtitles.style,
      aiHighlight: options.subtitles.aiHighlight,
      animations: options.subtitles.animations,
      accentColor: sub.emphasis.color,
    });
    const annotated = annotateTranscript(req.transcript, clipWords, styles);
    presetName = options.subtitles.preset ?? clip.subtitle_preset ?? undefined;
    preset = resolvePreset(presetName);
    events = buildTimelineSubtitleEvents(annotated, timeline, preset);
    if (events.length) {
      files = writeSubtitleFiles(clip.id, events, presetName || sub.preset, size);
      subtitleSource = plan.subtitle?.source ?? null;
      req.onProgress?.(35);
    }
  }

  // 3b. static quality review of the creative plan (bounded repair, before rendering)
  let qualityRepair: string[] = [];
  let qualityIssues: string[] = [];
  if (creativeEdl && options.creative.qualityReview) {
    const review = reviewCreativeStatic({ edl: creativeEdl, duration: outputDuration, events });
    if (!review.ok) {
      const repaired = repairEdl(creativeEdl, review.problems);
      const checked = validateEdl(repaired.edl, {
        duration: outputDuration,
        aspectRatio: aspect,
        clipStart: clip.start,
        clipEnd: clip.end,
      });
      if (checked.ok && checked.edl) creativeEdl = checked.edl;
      qualityRepair = [...qualityRepair, ...repaired.applied];
      if (repaired.applied.length) logger.warn('REVIEW', `creative plan repaired: ${repaired.applied.join('; ')}`);
      const again = reviewCreativeStatic({ edl: creativeEdl ?? creative!, duration: outputDuration, events });
      if (!again.ok) {
        qualityIssues = again.problems.map((p) => p.detail);
        logger.warn('REVIEW', `creative plan issues remain: ${qualityIssues.join('; ')}`);
      }
    }
  }

  const graphicsEdl =
    creativeEdl &&
    getSettings('creative').graphics &&
    (creativeEdl.titles.length > 0 ||
      creativeEdl.lowerThirds.length > 0 ||
      creativeEdl.statCards.length > 0 ||
      creativeEdl.callouts.length > 0 ||
      creativeEdl.style.progressBar)
      ? creativeEdl
      : null;

  // 4. Remotion overlay: captions and/or adaptive graphics (single ProRes pass)
  const engine = sub.engine ?? 'remotion';
  const wantCaptionOverlay = engine === 'remotion' && events.length > 0;
  if (wantCaptionOverlay || graphicsEdl) {
    const { renderCaptionOverlay } = await import('./caption-render.js');
    overlayPath = await renderCaptionOverlay({
      clipId: clip.id,
      events: wantCaptionOverlay ? events : [],
      preset,
      emphasis: sub.emphasis,
      width: size.w,
      height: size.h,
      fps: rs.fps,
      durationSec: outputDuration,
      mode: options.subtitles.style,
      animations: options.subtitles.animations,
      creative: graphicsEdl ? { edl: graphicsEdl } : null,
    });
    req.onProgress?.(45);
  }

  // 5. watermark layers + background music
  const watermarks = options.watermark.enabled ? resolveWatermarkLayers(options.watermark) : [];
  const musicPath = options.backgroundMusic.enabled ? resolveMusicFile(plan.music) : null;
  const musicBase: Omit<MusicMix, 'voiceDucking'> | null = musicPath
    ? {
        inputIndex: -1,
        volumeDb: options.backgroundMusic.volumeDb,
        duckDb: options.backgroundMusic.duckDb,
        fadeIn: options.backgroundMusic.fadeIn,
        fadeOut: options.backgroundMusic.fadeOut,
        targetLufs: musicSettings.music_target_lufs,
        duration: outputDuration,
      }
    : null;

  // speech windows on the output timeline (for ducking)
  const speechRanges = buildSpeechRanges(req.transcript, timeline);

  const assPath = files && (sub.engine ?? 'remotion') === 'ass' ? files.ass : null;

  let broll: Omit<BrollOverlaySpec, 'inputIndex'>[] = [];
  let sfx: Omit<SfxOverlaySpec, 'inputIndex'>[] = [];
  const buildArgsFor = (edl: Edl | null): string[] => {
    broll = [];
    sfx = [];
    if (edl && (edl.broll.length || edl.sfx.length)) {
      const contextText = (req.transcript ?? []).map((s) => s.text).join(' ');
      if (edl.broll.length) {
        const res = resolveBrollPlacements(edl.broll, contextText);
        broll = res.specs.map((s) => ({
          kind: s.asset.kind,
          path: s.asset.file_path,
          start: s.start,
          end: s.end,
          mode: s.mode,
          position: s.position,
          sizePercent: s.sizePercent,
        }));
        for (const d of [...res.dropped, ...res.warnings]) logger.debug('RENDER', `b-roll: ${d}`);
      }
      if (edl.sfx.length) {
        const res = resolveSfxPlacements(edl.sfx);
        sfx = res.specs.map((s) => ({ path: s.asset.file_path, at: s.at, volumeDb: s.volumeDb }));
        for (const d of res.dropped) logger.debug('RENDER', `sfx: ${d}`);
      }
    }
    const music: MusicMix | null = musicBase
      ? { ...musicBase, voiceDucking: options.backgroundMusic.voiceDucking && (edl?.audio.ducking ?? true) }
      : null;
    return buildRenderArgs({
      source: req.sourcePath,
      output: tmpOut,
      outputDuration,
      rs,
      clipStart: clip.start,
      timeline,
      plan: edl?.style.backgroundFill === 'fill-blur' ? null : framePlan,
      size,
      fps: rs.fps,
      assPath,
      captionPath: overlayPath,
      watermarks,
      musicPath,
      music,
      hasAudio: req.probe.hasAudio,
      speechRanges,
      voiceTargetLufs: musicSettings.voice_target_lufs,
      voiceTpDb: -1.5,
      truePeakDb: musicSettings.true_peak_db,
      broll,
      sfx,
      creative: edl
        ? {
            zoomKeys: buildZoomKeys(edl.framings, outputDuration, edl.style.punchIn),
            grade: edl.style.grade,
            backgroundFill: edl.style.backgroundFill,
            edgeFade: edl.style.edgeFade,
            transition: edl.style.transition.type,
            audio: edl.audio,
          }
        : null,
    });
  };
  let args = buildArgsFor(creativeEdl);

  let statSize = 0;
  const encodeOnce = async (encodeArgs: string[]): Promise<number> => {
    const t0 = Date.now();
    const { code, stderr } = await runCmd(config.ffmpeg, encodeArgs, {
      jobId: req.jobId,
      onStdout: (line) => {
        const t = parseProgressTime(line);
        if (t !== null) {
          req.onProgress?.(Math.min(95, 45 + Math.round((t / Math.max(0.1, outputDuration)) * 50)));
        }
      },
    });
    if (code !== 0) {
      try { fs.rmSync(tmpOut, { force: true }); } catch {}
      throw new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 1200)} … ${tail(stderr, 400)}`);
    }
    const stat = fs.statSync(tmpOut);
    if (stat.size < 10000) {
      try { fs.rmSync(tmpOut, { force: true }); } catch {}
      throw new Error('ffmpeg produced a suspiciously small file');
    }
    fs.renameSync(tmpOut, output);
    logger.info(
      'RENDER',
      `${clip.id} ${req.kind} -> ${path.basename(output)} (${(stat.size / 1e6).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
        `hook=${plan.hook ? plan.hook.source : 'none'}, music=${musicPath ? path.basename(musicPath) : 'none'}, wm=${watermarks.length}, ` +
        `broll=${broll.length}, sfx=${sfx.length})`
    );
    return stat.size;
  };

  statSize = await encodeOnce(args);
  if (overlayPath) try { fs.rmSync(overlayPath, { force: true }); } catch {}
  req.onProgress?.(97);

  // 6. QA: structure + audio levels + creative media review (at most one bounded re-encode)
  let out = await probeVideo(output);
  const runQa = async (): Promise<void> => {
    await qualityCheck(output, out, {
      expectedDuration: outputDuration,
      size,
      needAudio: req.probe.hasAudio,
      kinds: req.kind,
      files: assPath ? files : null,
    });
    await qualityCheckLoudness(output, req.probe.hasAudio);
  };
  await runQa();

  if (creativeEdl && options.creative.qualityReview) {
    const media = await reviewOutputMedia(output, outputDuration, { jobId: req.jobId });
    if (!media.ok) {
      const repaired = repairEdl(creativeEdl, media.problems);
      if (repaired.applied.length) {
        logger.warn('REVIEW', `media review failed, re-encoding once: ${repaired.applied.join('; ')}`);
        qualityRepair = [...qualityRepair, ...repaired.applied];
        creativeEdl = repaired.edl;
        args = buildArgsFor(creativeEdl);
        statSize = await encodeOnce(args);
        out = await probeVideo(output);
        await runQa();
        const again = await reviewOutputMedia(output, outputDuration, { jobId: req.jobId });
        if (!again.ok) qualityIssues = [...qualityIssues, ...again.problems.map((p) => p.detail)];
      } else {
        qualityIssues = [...qualityIssues, ...media.problems.map((p) => p.detail)];
        logger.warn('REVIEW', `media review issues (not repairable): ${media.problems.map((p) => p.detail).join('; ')}`);
      }
    }
  }
  req.onProgress?.(100);

  return {
    output,
    duration: out.duration,
    width: out.width,
    height: out.height,
    size: statSize,
    subtitles: files,
    reframe: { usedTracking: framePlan.usedTracking, aspect },
    summary: {
      hook: !!plan.hook,
      hookSource: plan.hook?.source ?? 'none',
      music: plan.music?.name ?? null,
      musicSource: plan.music?.source ?? null,
      subtitleSource,
      watermarkCount: watermarks.length,
      optionsHash: plan.optionsHash,
      creativeMode: creative ? 'adaptive' : 'basic',
      creativeSource: plan.creativeSource ?? null,
      qualityRepair,
      qualityIssues,
    },
  };
}

/** Transcript speech windows mapped onto the output timeline (skip the cut hook span). */
export function buildSpeechRanges(transcript: TranscriptSegment[] | null, timeline: TimelinePlan): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  if (!transcript?.length) return ranges;
  for (const seg of transcript) {
    for (const tl of timeline.segments) {
      const s = Math.max(seg.start, tl.sourceStart);
      const e = Math.min(seg.end, tl.sourceEnd);
      if (e - s < 0.15) continue;
      ranges.push({ start: tl.outputStart + (s - tl.sourceStart), end: tl.outputStart + (e - tl.sourceStart) });
    }
  }
  return ranges;
}

export function resolvePreset(name?: string | null): SubtitlePreset {
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

/** Parse the ebur128 summary from ffmpeg stderr (last occurrence wins). */
export function parseLoudness(stderr: string): { integrated: number; truePeak: number } | null {
  const iMatches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/g)];
  const pMatches = [...stderr.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/g)];
  if (!iMatches.length || !pMatches.length) return null;
  return {
    integrated: parseFloat(iMatches[iMatches.length - 1][1]),
    truePeak: parseFloat(pMatches[pMatches.length - 1][1]),
  };
}

/** Loudness sanity gate: catches a broken/ducked-into-oblivion mix. */
export async function qualityCheckLoudness(file: string, needAudio: boolean): Promise<void> {
  if (!needAudio) return;
  const { code, stderr } = await runCmd(config.ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'info', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], {});
  if (code !== 0) {
    logger.warn('RENDER', `loudness measurement failed (continuing): ${tail(stderr, 200)}`);
    return; // measurement is advisory — do not fail an otherwise valid render
  }
  const l = parseLoudness(stderr);
  if (!l) return;
  logger.debug('RENDER', `loudness ${file}: I=${l.integrated} LUFS, peak=${l.truePeak} dBFS`);
  if (l.integrated < -45 || l.integrated > -4) {
    throw new Error(`QA failed: integrated loudness ${l.integrated} LUFS is out of range (-45..-4)`);
  }
  if (l.truePeak > 0.5) {
    throw new Error(`QA failed: true peak ${l.truePeak} dBFS clips`);
  }
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}
