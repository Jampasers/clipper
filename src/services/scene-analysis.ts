import { config } from '../config.js';
import { runCmd } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { trackFaceSamples, type TrackPoint } from './reframe.js';

/**
 * Deterministic visual analysis of a clip window. Runs locally with FFmpeg
 * signalstats + scene scoring + blackdetect, and reuses the OpenCV face tracker
 * for speaker position + face size. It produces the signals the Creative
 * Director, the Adaptive Style Engine and the quality reviewer reason about.
 * Nothing here calls an AI model.
 */

export interface BrightnessSample {
  t: number;
  y: number;
}

export interface SceneCut {
  t: number;
  score: number;
}

export interface BlackSpan {
  start: number;
  end: number;
}

export interface FaceSample {
  t: number;
  cx: number;
  faces: number;
  w: number;
}

export type ShotSize = 'wide' | 'medium' | 'close';

export interface ShotHint {
  start: number;
  end: number;
  size: ShotSize;
}

export interface SceneAnalysis {
  windowStart: number;
  windowEnd: number;
  brightness: BrightnessSample[];
  avgBrightness: number;
  dark: boolean;
  bright: boolean;
  cuts: SceneCut[];
  blackSpans: BlackSpan[];
  faces: FaceSample[];
  faceCoverage: number;
  shotHints: ShotHint[];
  hasSpeech: boolean;
}

export const EMPTY_SCENE_ANALYSIS: SceneAnalysis = {
  windowStart: 0,
  windowEnd: 0,
  brightness: [],
  avgBrightness: 0,
  dark: false,
  bright: false,
  cuts: [],
  blackSpans: [],
  faces: [],
  faceCoverage: 0,
  shotHints: [],
  hasSpeech: false,
};

const SAMPLE_FPS = 5;
const SCENE_THRESHOLD = 0.35;
const BLACK_MIN_DUR = 0.35;

/** Parse `metadata=print` + `blackdetect` log lines (stderr or stdout). */
export function parseSceneLog(
  log: string
): { brightness: BrightnessSample[]; cuts: SceneCut[]; blackSpans: BlackSpan[] } {
  const brightness: BrightnessSample[] = [];
  let currentT: number | null = null;
  let envT: number | null = null;
  const cuts: SceneCut[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    const pts = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (pts) {
      currentT = parseFloat(pts[1]);
      continue;
    }
    const y = /lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/.exec(line);
    if (y && currentT !== null) {
      brightness.push({ t: round3(currentT), y: parseFloat(y[1]) });
      continue;
    }
    const sc = /lavfi\.scene_score=(\d+(?:\.\d+)?)/.exec(line);
    if (sc && currentT !== null) {
      cuts.push({ t: round3(currentT), score: parseFloat(sc[1]) });
    }
  }
  const blackSpans: BlackSpan[] = [];
  const bd = /black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = bd.exec(log)) !== null) {
    const start = parseFloat(m[1]);
    const end = parseFloat(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) blackSpans.push({ start: round3(start), end: round3(end) });
  }
  return { brightness, cuts, blackSpans };
}

/** Parse the raw JSON lines emitted by scripts/track_faces.py. */
export function parseFaceSamples(log: string): FaceSample[] {
  const out: FaceSample[] = [];
  for (const line of log.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; t?: number; cx?: number; faces?: number; w?: number };
      if (obj.type !== 'point' || typeof obj.t !== 'number' || typeof obj.cx !== 'number') continue;
      out.push({ t: obj.t, cx: obj.cx, faces: obj.faces ?? 0, w: obj.w ?? 0 });
    } catch {
      /* sidecar diagnostics are not JSON */
    }
  }
  return out;
}

/** Group consecutive face samples into shot-size hints from the tracked face width. */
export function classifyShots(faces: FaceSample[]): ShotHint[] {
  if (!faces.length) return [];
  const sizeOf = (w: number): ShotSize => (w >= 0.18 ? 'close' : w >= 0.09 ? 'medium' : 'wide');
  const hints: ShotHint[] = [];
  for (const f of faces) {
    if (!f.w) continue;
    const size = sizeOf(f.w);
    const last = hints[hints.length - 1];
    if (last && last.size === size && f.t - last.end <= 1.6) last.end = round3(f.t);
    else hints.push({ start: round3(f.t), end: round3(f.t), size });
  }
  return hints.filter((h) => h.end - h.start >= 0.4 - 1e-6);
}

export function summarizeScene(
  windowStart: number,
  windowEnd: number,
  parsed: { brightness: BrightnessSample[]; cuts: SceneCut[]; blackSpans: BlackSpan[] },
  faces: FaceSample[],
  hasSpeech: boolean
): SceneAnalysis {
  const ys = parsed.brightness.map((b) => b.y);
  const avgBrightness = ys.length ? round1(ys.reduce((a, b) => a + b, 0) / ys.length) : 0;
  const significantCuts = parsed.cuts.filter((c) => c.score >= SCENE_THRESHOLD);
  const faceCoverage = faces.length ? round2(faces.filter((f) => f.faces > 0).length / faces.length) : 0;
  return {
    windowStart,
    windowEnd,
    brightness: parsed.brightness,
    avgBrightness,
    dark: ys.length > 0 && avgBrightness < 60,
    bright: avgBrightness > 200,
    cuts: significantCuts,
    blackSpans: parsed.blackSpans,
    faces,
    faceCoverage,
    shotHints: classifyShots(faces),
    hasSpeech,
  };
}

/**
 * Analyze the clip window (plus a small context margin). Face tracking failure
 * degrades to "no faces" instead of failing the build; other FFmpeg failures
 * degrade to an empty analysis (the render has deterministic defaults).
 */
export async function analyzeScene(input: {
  sourcePath: string;
  windowStart: number;
  windowEnd: number;
  speech: { start: number; end: number }[];
  sourceDuration?: number;
}): Promise<SceneAnalysis> {
  const start = Math.max(0, input.windowStart - 2);
  const end = Math.min(
    input.sourceDuration && input.sourceDuration > 0 ? input.sourceDuration : input.windowEnd + 2,
    input.windowEnd + 2
  );
  if (end - start < 0.5) return { ...EMPTY_SCENE_ANALYSIS, windowStart: start, windowEnd: end };

  const filter = `fps=${SAMPLE_FPS},scale=320:-2,signalstats,select='gte(scene\\,0)',metadata=print,blackdetect=d=${BLACK_MIN_DUR}:pix_th=0.10`;
  let parsed = { brightness: [] as BrightnessSample[], cuts: [] as SceneCut[], blackSpans: [] as BlackSpan[] };
  try {
    const { code, stdout, stderr } = await runCmd(config.ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'info', '-ss', start.toFixed(3), '-t', (end - start).toFixed(3),
      '-i', input.sourcePath, '-vf', filter, '-an', '-f', 'null', '-',
    ]);
    if (code !== 0) {
      logger.warn('VIDEO', `scene analysis ffmpeg exited ${code}: ${stderr.slice(-200)}`);
    }
    parsed = parseSceneLog(`${stderr}\n${stdout}`);
  } catch (err) {
    logger.warn('VIDEO', `scene analysis failed: ${String((err as Error).message).slice(0, 200)}`);
  }

  let faces: FaceSample[] = [];
  try {
    const points: TrackPoint[] = await trackFaceSamples(input.sourcePath, input.windowStart, input.windowEnd, 0.7, input.speech);
    faces = points.map((p) => ({ t: round3(p.t), cx: p.cx, faces: 1, w: round3(p.w ?? 0) }));
  } catch (err) {
    logger.info('VIDEO', `scene analysis: face tracking unavailable (${String((err as Error).message).slice(0, 120)})`);
  }

  return summarizeScene(start, end, parsed, faces, input.speech.length > 0);
}

export function cutsPerMinute(scene: SceneAnalysis): number {
  const dur = Math.max(1, scene.windowEnd - scene.windowStart);
  return (scene.cuts.length / dur) * 60;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
