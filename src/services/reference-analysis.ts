import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runCmd } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { generateVision } from '../lib/ai.js';
import { q, J } from '../lib/sqlite.js';
import {
  clearReferenceFrames, getReference, getLatestAnalysis, referenceFramesDir, referenceDir,
  setReferenceAnalysisVersion, setReferenceStatus, writeReferenceMeta,
  type ReferenceRow,
} from './reference-library.js';
import {
  buildStyleProfile, STYLE_PROFILE_VERSION, EMPTY_MEASUREMENTS,
  type AiObservations, type ReferenceMeasurements, type StyleProfile,
} from './style-profile.js';

/**
 * Reference analysis pipeline (runs inside the `reference_analysis` worker job,
 * never on the API thread):
 *
 *  1. deterministic FFmpeg measurement passes (brightness/contrast/saturation,
 *     scene cuts, inter-frame motion, subtitle-band activity, loudness/silence)
 *  2. intelligent frame sampling (scene boundaries, motion peaks, subtitle-band
 *     peaks, uniform coverage, intro/outro — never blind fixed intervals)
 *  3. vision model pass over small JPEG frames (resized, capped count)
 *  4. text classification pass for category/tags when vision does not supply them
 *  5. validated, versioned StyleProfile persisted in reference_analyses
 *
 * If the vision model is unavailable the profile still persists with the locally
 * measured facts and confidence 0 on every purely-visual field — we never
 * fabricate visual observations.
 */

export const ANALYSIS_VERSION = 1;

const SCENE_THRESHOLD = 0.35;

export interface SampledFrame {
  index: number;
  t: number;
  file: string;
  reasons: string[];
}

/* ---------------- measurement passes ---------------- */

interface StatFrame {
  t: number;
  yavg?: number;
  ymin?: number;
  ymax?: number;
  satavg?: number;
  scene?: number;
}

function parseSignalStats(log: string): StatFrame[] {
  const frames: StatFrame[] = [];
  let current: StatFrame | null = null;
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    const pts = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (pts) {
      current = { t: parseFloat(pts[1]) };
      frames.push(current);
      continue;
    }
    if (!current) continue;
    const yavg = /lavfi\.signalstats\.YAVG=(-?\d+(?:\.\d+)?)/.exec(line);
    if (yavg) current.yavg = parseFloat(yavg[1]);
    const ymin = /lavfi\.signalstats\.YMIN=(-?\d+(?:\.\d+)?)/.exec(line);
    if (ymin) current.ymin = parseFloat(ymin[1]);
    const ymax = /lavfi\.signalstats\.YMAX=(-?\d+(?:\.\d+)?)/.exec(line);
    if (ymax) current.ymax = parseFloat(ymax[1]);
    const sat = /lavfi\.signalstats\.SATAVG=(-?\d+(?:\.\d+)?)/.exec(line);
    if (sat) current.satavg = parseFloat(sat[1]);
    const sc = /lavfi\.scene_score=(\d+(?:\.\d+)?)/.exec(line);
    if (sc) current.scene = parseFloat(sc[1]);
  }
  return frames;
}

export function parseSilence(log: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const raw of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(raw);
    if (s) start = parseFloat(s[1]);
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(raw);
    if (e && start !== null) {
      spans.push({ start, end: parseFloat(e[1]) });
      start = null;
    }
  }
  return spans;
}

/** Parse the ebur128 summary line (kept local to avoid a render.ts import cycle). */
/** Parse the final ebur128 summary (kept local to avoid a render.ts import cycle). */
export function parseEbur128(stderr: string): { integrated: number; lra: number; truePeak: number } | null {
  const i = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/g)];
  const lra = [...stderr.matchAll(/LRA:\s*(-?\d+(?:\.\d+)?)\s+LU\b/g)];
  const peak = [...stderr.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/g)];
  if (!i.length) return null;
  return {
    integrated: parseFloat(i[i.length - 1][1]),
    lra: lra.length ? parseFloat(lra[lra.length - 1][1]) : 0,
    truePeak: peak.length ? parseFloat(peak[peak.length - 1][1]) : 0,
  };
}

function mean(ns: number[]): number | null {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

export interface MeasurementResult {
  measurements: ReferenceMeasurements;
  series: {
    /** inter-frame motion 0..1 per sample */
    motion: { t: number; v: number }[];
    /** bottom-band (subtitle/graphics) activity 0..1 per sample */
    subtitle: { t: number; v: number }[];
  };
}

/** Run every deterministic FFmpeg pass and derive the measurement block. */
export async function measureReference(sourcePath: string, duration: number): Promise<MeasurementResult> {
  const measurements: ReferenceMeasurements = { ...EMPTY_MEASUREMENTS, duration };
  const series: MeasurementResult['series'] = { motion: [], subtitle: [] };

  // visual pass: brightness/contrast/saturation + scene scores
  try {
    const visualFilter = "fps=5,scale=320:-2,signalstats,select='gte(scene\\,0)',metadata=print";
    const { stderr } = await runCmd(config.ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'info', '-i', sourcePath,
      '-vf', visualFilter, '-an', '-f', 'null', '-',
    ]);
    const frames = parseSignalStats(stderr);
    const withStats = frames.filter((f) => typeof f.yavg === 'number');
    if (withStats.length) {
      const bright = mean(withStats.map((f) => f.yavg as number));
      measurements.brightness = bright === null ? null : clamp01(bright / 255);
      const contrast = mean(withStats.filter((f) => typeof f.ymax === 'number' && typeof f.ymin === 'number').map((f) => (f.ymax! - f.ymin!) / 255));
      measurements.contrast = contrast === null ? null : clamp01(contrast * 1.6);
      const sat = mean(withStats.filter((f) => typeof f.satavg === 'number').map((f) => f.satavg! / 128));
      measurements.saturation = sat === null ? null : clamp01(sat);
      measurements.sampledFrames = withStats.length;
    }
    const cuts = frames.filter((f) => (f.scene ?? 0) >= SCENE_THRESHOLD).map((f) => round2(f.t)).filter((t) => t > 0.3);
    measurements.cutCount = cuts.length;
    measurements.cuts = cuts.slice(0, 4000);
    if (cuts.length >= 2 && duration > 0) {
      const shots = cutSpans(cuts, duration);
      measurements.averageShotDuration = round2(meanLen(shots));
      measurements.cutCpm = round2((cuts.length / duration) * 60);
    } else if (cuts.length === 0) {
      measurements.cutCpm = 0;
      measurements.averageShotDuration = round2(Math.max(duration, 0.1));
    }
  } catch (e) {
    logger.warn('VIDEO', `reference visual measurement failed: ${(e as Error).message.slice(0, 160)}`);
  }

  // motion pass (inter-frame difference at low res)
  try {
    const { stderr } = await runCmd(config.ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'info', '-i', sourcePath,
      '-vf', 'fps=3,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print', '-an', '-f', 'null', '-',
    ]);
    const frames = parseSignalStats(stderr).filter((f) => typeof f.yavg === 'number');
    series.motion = frames.map((f) => ({ t: round2(f.t), v: clamp01(f.yavg! / 48) }));
    const m = mean(frames.map((f) => f.yavg!));
    measurements.motionIntensity = m === null ? null : clamp01(m / 48);
  } catch (e) {
    logger.warn('VIDEO', `reference motion measurement failed: ${(e as Error).message.slice(0, 160)}`);
  }

  // subtitle-band activity pass (bottom quarter of the frame)
  try {
    const { stderr } = await runCmd(config.ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'info', '-i', sourcePath,
      '-vf', 'fps=2,crop=iw:ih*0.25:0:ih*0.70,tblend=all_mode=difference,signalstats,metadata=print', '-an', '-f', 'null', '-',
    ]);
    const frames = parseSignalStats(stderr).filter((f) => typeof f.yavg === 'number');
    series.subtitle = frames.map((f) => ({ t: round2(f.t), v: clamp01(f.yavg! / 48) }));
    const m = mean(frames.map((f) => f.yavg!));
    measurements.subtitleActivity = m === null ? null : clamp01(m / 48);
  } catch (e) {
    logger.warn('VIDEO', `reference subtitle-band measurement failed: ${(e as Error).message.slice(0, 160)}`);
  }

  // audio pass: loudness + silence
  if (duration > 0) {
    try {
      const { stderr } = await runCmd(config.ffmpeg, [
        '-hide_banner', '-nostdin', '-i', sourcePath,
        '-af', 'ebur128=peak=true,silencedetect=noise=-35dB:d=1.5', '-f', 'null', '-',
      ]);
      const loudness = parseEbur128(stderr);
      if (loudness) {
        measurements.integratedLoudness = loudness.integrated;
        measurements.loudnessRange = loudness.lra;
        measurements.truePeak = loudness.truePeak;
      }
      const spans = parseSilence(stderr).filter((s) => s.end > s.start);
      const silence = spans.reduce((a, s) => a + (s.end - s.start), 0);
      measurements.silenceRatio = clamp01(silence / duration);
    } catch (e) {
      logger.warn('VIDEO', `reference audio measurement failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  return { measurements, series };
}

export function cutSpans(cuts: number[], duration: number): { start: number; end: number }[] {
  const edges = [0, ...cuts.filter((t) => t > 0 && t < duration), duration];
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] - edges[i] > 0.01) spans.push({ start: edges[i], end: edges[i + 1] });
  }
  return spans;
}

function meanLen(spans: { start: number; end: number }[]): number {
  return spans.length ? spans.reduce((a, s) => a + (s.end - s.start), 0) / spans.length : 0;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- intelligent frame sampling ---------------- */

/**
 * Deterministic sampler. Priorities: scene boundaries, high-motion / camera
 * movement moments, subtitle/graphics-band peaks, then uniform coverage;
 * bookended with intro/outro. Never a blind fixed-interval sweep.
 */
export function chooseSampleTimes(
  result: MeasurementResult,
  maxFrames: number,
  opts: { windowStart?: number; windowEnd?: number } = {}
): { t: number; reasons: string[] }[] {
  const { measurements, series } = result;
  const start = Math.max(0.2, opts.windowStart ?? 0.2);
  const end = Math.max(start + 0.5, (opts.windowEnd ?? measurements.duration) - 0.4);
  const span = end - start;
  if (span <= 0 || maxFrames <= 0) return [];
  const picks: { t: number; reasons: string[] }[] = [];
  const taken: number[] = [];

  const tryTake = (t: number, reason: string) => {
    const clamped = Math.min(end, Math.max(start, round2(t)));
    if (picks.length >= maxFrames) return;
    if (taken.some((x) => Math.abs(x - clamped) < 1.5)) return;
    picks.push({ t: clamped, reasons: [reason] });
    taken.push(clamped);
  };

  tryTake(start, 'intro');
  tryTake(end - 0.3, 'outro');

  // 1. scene boundaries
  const cuts = measurements.cuts.filter((t) => t >= start && t <= end);
  for (const cut of cuts) {
    tryTake(cut + 0.15, 'scene_boundary');
    if (picks.filter((p) => p.reasons.includes('scene_boundary')).length >= Math.max(2, Math.floor(maxFrames * 0.35))) break;
  }

  // 2. motion / camera-movement peaks
  const motionPeaks = series.motion
    .filter((s) => s.t >= start && s.t <= end && s.v >= 0.18)
    .sort((a, b) => b.v - a.v);
  for (const peak of motionPeaks) {
    tryTake(peak.t, 'motion_peak');
    if (picks.filter((p) => p.reasons.includes('motion_peak')).length >= Math.max(1, Math.floor(maxFrames * 0.25))) break;
  }

  // 3. subtitle / graphics-band peaks
  const subtitlePeaks = series.subtitle
    .filter((s) => s.t >= start && s.t <= end && s.v >= 0.15)
    .sort((a, b) => b.v - a.v);
  for (const peak of subtitlePeaks) {
    tryTake(peak.t, 'subtitle_activity_peak');
    if (picks.filter((p) => p.reasons.includes('subtitle_activity_peak')).length >= 2) break;
  }

  // 4. coverage fill
  const budget = Math.max(0, maxFrames - picks.length);
  if (budget > 0) {
    const step = span / (budget + 1);
    for (let i = 1; i <= budget; i++) tryTake(start + step * i, 'coverage');
  }

  return picks.sort((a, b) => a.t - b.t);
}

export function extractFrames(
  id: string,
  sourcePath: string,
  times: { t: number; reasons: string[] }[],
  width: number
): Promise<SampledFrame[]> {
  const dir = referenceFramesDir(id);
  return new Promise((resolve) => {
    const out: SampledFrame[] = [];
    let done = false;
    const next = async (): Promise<void> => {
      if (done || out.length >= times.length || out.length >= 60) {
        done = true;
        resolve(out);
        return;
      }
      const spec = times[out.length];
      const file = path.join(dir, `f${String(out.length + 1).padStart(2, '0')}.jpg`);
      const { code, stderr } = await runCmd(config.ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', spec.t.toFixed(3), '-i', sourcePath,
        '-frames:v', '1',
        '-vf', `scale=${Math.min(width, 1280)}:-2`,
        '-q:v', '5',
        file,
      ]);
      if (code === 0 && fs.existsSync(file) && fs.statSync(file).size > 500) {
        out.push({ index: out.length + 1, t: spec.t, file, reasons: [...spec.reasons] });
      } else {
        logger.warn('VIDEO', `reference frame ${spec.t.toFixed(2)}s failed (${code}): ${stderr.slice(-120)}`);
      }
      await next();
    };
    void next();
  });
}

/* ---------------- vision + classification ---------------- */

function framesPrompt(frames: SampledFrame[]): string {
  return frames.map((f) => `frame ${f.index}: ${f.t.toFixed(2)}s (${f.reasons.join(', ')})`).join('\n');
}

const VISION_SYSTEM =
  'You are a professional video editor analysing reference footage. Trust the provided frame timestamps and measurements. Never invent values the frames do not show. Respond with JSON only.';

export interface VisionOutcome {
  observations: AiObservations | null;
  model: string | null;
  error: string | null;
}

export async function analyzeWithVision(frames: SampledFrame[], measurements: ReferenceMeasurements, meta: ReferenceRow): Promise<VisionOutcome> {
  if (!frames.length) return { observations: null, model: null, error: 'no frames sampled' };
  const vars = {
    meta: `name: ${meta.name}\ndescription: ${meta.description ?? '(none)'}\nduration: ${measurements.duration.toFixed(1)}s\nresolution: ${measurements.width}x${measurements.height}\nfps: ${measurements.fps}`,
    measurements: JSON.stringify(compactMeasurements(measurements)).slice(0, 1600),
    frames: framesPrompt(frames),
  };
  const images = frames.map((f) => ({ data: fs.readFileSync(f.file).toString('base64'), mime: 'image/jpeg' }));
  try {
    const res = await generateVision<AiObservations>('reference_visual_analysis', vars, images, VISION_SYSTEM);
    return { observations: res.json, model: res.model, error: null };
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    logger.warn('AI', `reference vision analysis failed: ${msg}`);
    return { observations: null, model: null, error: msg };
  }
}

function compactMeasurements(m: ReferenceMeasurements): Record<string, unknown> {
  const out: Record<string, unknown> = {
    duration_s: round2(m.duration),
    cut_count: m.cutCount,
  };
  if (m.cutCpm !== null) out.cut_rate_per_minute = round2(m.cutCpm);
  if (m.averageShotDuration !== null) out.average_shot_seconds = round2(m.averageShotDuration);
  if (m.brightness !== null) out.brightness_0_1 = round2(m.brightness);
  if (m.contrast !== null) out.contrast_0_1 = round2(m.contrast);
  if (m.saturation !== null) out.saturation_0_1 = round2(m.saturation);
  if (m.motionIntensity !== null) out.motion_0_1 = round2(m.motionIntensity);
  if (m.subtitleActivity !== null) out.subtitle_band_activity_0_1 = round2(m.subtitleActivity);
  if (m.loudnessRange !== null) out.loudness_range_lu = round2(m.loudnessRange);
  if (m.integratedLoudness !== null) out.integrated_lufs = round2(m.integratedLoudness);
  if (m.silenceRatio !== null) out.silence_ratio_0_1 = round2(m.silenceRatio);
  return out;
}

/** Text classification from the summary; keeps the vision model prompt small. */
export async function classifyReference(
  meta: ReferenceRow,
  measurements: ReferenceMeasurements,
  visionCategories: string[]
): Promise<{ categories: string[]; tags: string[]; model: string | null }> {
  const categories = visionCategories.length ? visionCategories : [];
  // no AI when vision already classified and there is nothing new to learn
  if (categories.length && !shouldClassifyAgain(meta)) {
    return { categories, tags: J.read<string[]>(meta.tags) ?? [], model: null };
  }
  const summary = [
    `name: ${meta.name}`,
    meta.description ? `description: ${meta.description}` : null,
    `duration: ${measurements.duration.toFixed(1)}s, ${measurements.width}x${measurements.height}`,
    `cut rate: ${measurements.cutCpm === null ? 'unknown' : `${round2(measurements.cutCpm)}/min`}`,
    measurements.brightness !== null ? `brightness: ${round2(measurements.brightness)}` : null,
    measurements.silenceRatio !== null ? `speech silence ratio: ${round2(measurements.silenceRatio)}` : null,
    categories.length ? `vision saw: ${categories.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  try {
    const { generate } = await import('../lib/ai.js');
    const res = await generate<{ categories?: unknown; tags?: unknown }>('reference_classification', { summary });
    const sanitized = sanitizeClassification(res.json);
    return {
      categories: sanitized?.categories?.length ? sanitized.categories : categories,
      tags: sanitized?.tags?.length ? sanitized.tags : J.read<string[]>(meta.tags) ?? [],
      model: res.model,
    };
  } catch (e) {
    logger.warn('AI', `reference classification failed: ${String((e as Error).message).slice(0, 160)}`);
    return { categories, tags: J.read<string[]>(meta.tags) ?? [], model: null };
  }
}

function shouldClassifyAgain(meta: ReferenceRow): boolean {
  return !meta.category && !meta.description;
}

function sanitizeClassification(raw: { categories?: unknown; tags?: unknown }): { categories: string[]; tags: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const arr = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, max) : [];
  return { categories: arr(raw.categories, 5), tags: arr(raw.tags, 8) };
}

/* ---------------- persistence + orchestration ---------------- */

function persistAnalysis(
  ref: ReferenceRow,
  profile: StyleProfile,
  measurements: ReferenceMeasurements,
  evidence: Record<string, unknown>,
  status: 'complete' | 'partial',
  model: string | null,
  error: string | null
): void {
  q.run(
    `INSERT INTO reference_analyses (reference_id, profile_version, analysis_version, status, profile, measurements, evidence, model, prompt_meta, error)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(reference_id, analysis_version) DO UPDATE SET
       status = excluded.status, profile = excluded.profile, measurements = excluded.measurements,
       evidence = excluded.evidence, model = excluded.model, prompt_meta = excluded.prompt_meta, error = excluded.error`,
    ref.id,
    STYLE_PROFILE_VERSION,
    ANALYSIS_VERSION,
    status,
    JSON.stringify(profile),
    JSON.stringify(measurements),
    JSON.stringify(evidence),
    model,
    JSON.stringify({ task: 'reference_visual_analysis', profileVersion: STYLE_PROFILE_VERSION, analysisVersion: ANALYSIS_VERSION }),
    error
  );
}

export interface AnalyzeOutcome {
  referenceId: string;
  status: 'analyzed' | 'partial' | 'failed';
  reused: boolean;
  profile: StyleProfile | null;
}

/**
 * Full analysis for one reference. Idempotent: a complete analysis for the
 * current ANALYSIS_VERSION short-circuits unless `force` is set.
 */
export async function analyzeReference(id: string, opts: { force?: boolean; report?: (p: number) => void } = {}): Promise<AnalyzeOutcome> {
  const ref = getReference(id);
  if (!ref) throw new Error(`reference ${id} not found`);
  const settings = getSettings('learning');
  const report = opts.report ?? (() => {});

  if (!opts.force) {
    const existing = getLatestAnalysis(id);
    if (existing && existing.status === 'complete' && ref.analysis_version === ANALYSIS_VERSION) {
      setReferenceStatus(id, 'analyzed', null);
      return { referenceId: id, status: 'analyzed', reused: true, profile: J.read<StyleProfile>(existing.profile) ?? null };
    }
  }

  setReferenceAnalysisVersion(id, ANALYSIS_VERSION);
  setReferenceStatus(id, 'analyzing', null);
  clearReferenceFrames(id);

  try {
    report(5);
    const { measurements, series } = await measureReference(ref.source_path, ref.duration ?? 0);
    report(35);
    const times = chooseSampleTimes({ measurements, series }, settings.vision_max_frames);
    const frames = await extractFrames(id, ref.source_path, times, settings.vision_frame_width);
    report(55);
    const vision = await analyzeWithVision(frames, measurements, ref);
    report(75);
    const classified = await classifyReference(ref, measurements, vision.observations?.categories ? vision.observations.categories as string[] : []);
    report(85);

    const ai = vision.observations;
    const profile = buildStyleProfile({
      ai,
      measurements,
      meta: { name: ref.name, duration: ref.duration ?? 0, width: ref.width ?? 0, height: ref.height ?? 0, fps: ref.fps ?? 0 },
      model: vision.model,
      promptVersion: 1,
    });
    if (classified.categories.length) {
      const merged = Array.from(new Set([...profile.category, ...classified.categories])).slice(0, 5);
      profile.category = merged;
     }
    if (classified.tags.length) {
      profile.tags = Array.from(new Set([...profile.tags, ...classified.tags])).slice(0, 12);
    }

    const primaryCategory = profile.category[0] ?? ref.category ?? null;
    const mergedTags = Array.from(new Set([...(J.read<string[]>(ref.tags) ?? []), ...profile.tags])).slice(0, 12);
    q.run(
      "UPDATE reference_library SET category = ?, tags = ?, width = COALESCE(?, width), height = COALESCE(?, height), fps = COALESCE(?, fps), updated_at = datetime('now') WHERE id = ?",
      primaryCategory,
      mergedTags.length ? JSON.stringify(mergedTags) : null,
      ref.width || null,
      ref.height || null,
      ref.fps || null,
      id
    );

    const refStatus: 'analyzed' | 'partial' = ai ? 'analyzed' : 'partial';
    const analysisStatus: 'complete' | 'partial' = ai ? 'complete' : 'partial';
    persistAnalysis(ref, profile, measurements, {
      frames: frames.map((f) => ({ index: f.index, t: f.t, reasons: f.reasons })),
      sampling: { requested: settings.vision_max_frames, sampled: frames.length, times },
      visionError: vision.error,
      classificationModel: classified.model ?? null,
    }, analysisStatus, vision.model, vision.error);

    setReferenceStatus(id, refStatus, vision.error);
    writeReferenceMeta(id);
    logger.info('AI', `reference ${id} analyzed: status=${refStatus} confidence=${profile.confidence} category=${primaryCategory ?? '-'}`);
    report(100);
    return { referenceId: id, status: refStatus, reused: false, profile };
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    setReferenceStatus(id, 'failed', msg);
    writeReferenceMeta(id);
    throw e;
  } finally {
    clearReferenceFrames(id);
  }
}
