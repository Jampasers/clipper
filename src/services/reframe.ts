import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';

/** Tracked center expressed as fraction of source width (0..1). */
export interface TrackPoint {
  t: number;
  cx: number;
}

export interface Frame {
  t: number;
  cx: number;
}

export function aspectSize(aspect: '9:16' | '1:1' | '16:9', height: number): { w: number; h: number } {
  const ratios = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
  return { w: Math.round((height * ratios[aspect]) / 2) * 2, h: height };
}

export interface ReframePlan {
  aspect: '9:16' | '1:1' | '16:9';
  /** source crop width in source pixels */
  cropW: number;
  cropH: number;
  /** smoothed keyframes, t seconds clip-relative, cx center in source pixels */
  frames: Frame[];
  usedTracking: boolean;
}

/** Sample center per short window, smooth with a moving average and speed limit. */
export function smoothTrack(points: TrackPoint[], opts: { window: number; maxSpeed: number; deadzone: number; fallbackCx: number; startT: number; endT: number; jumpPx?: number }): Frame[] {
  if (points.length === 0) return [{ t: opts.startT, cx: opts.fallbackCx }];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const n = Math.max(1, opts.window);
  const smoothed = sorted.map((p, i) => {
    const from = Math.max(0, i - Math.floor(n / 2));
    const to = Math.min(sorted.length, i + Math.ceil(n / 2));
    let sum = 0;
    let c = 0;
    for (let j = from; j < to; j++) {
      // never average across a speaker-switch jump, or the teleport smears
      // into a slow crawl and the whip-pan below never sees it
      if (opts.jumpPx && Math.abs(sorted[j].cx - p.cx) > opts.jumpPx) continue;
      sum += sorted[j].cx;
      c++;
    }
    return { t: p.t, cx: sum / c };
  });

  // rate-limit pan: each point may not move more than maxSpeed*dt from previous
  const limited: Frame[] = [];
  let prev = smoothed[0];
  limited.push({ t: Math.max(opts.startT, smoothed[0].t), cx: smoothed[0].cx });
  for (let i = 1; i < smoothed.length; i++) {
    const cur = smoothed[i];
    const dt = Math.max(0.001, cur.t - prev.t);
    const maxDelta = opts.maxSpeed * dt;
    let cx = cur.cx;
    const delta = cx - prev.cx;
    if (Math.abs(delta) > maxDelta) {
      if (opts.jumpPx && Math.abs(delta) > opts.jumpPx) {
        // speaker switch: hold the old center until 0.3s before the new one,
        // then whip over, instead of crawling there at maxSpeed for seconds
        limited.push({ t: Math.max(opts.startT, Math.max(prev.t, cur.t - 0.3)), cx: prev.cx });
      } else {
        cx = prev.cx + Math.sign(delta) * maxDelta;
      }
    }
    if (Math.abs(cx - prev.cx) < opts.deadzone) cx = prev.cx; // deadzone suppresses jitter
    limited.push({ t: Math.max(opts.startT, cur.t), cx });
    prev = { t: cur.t, cx };
  }

  if (limited.length === 1) limited.push({ t: Math.max(opts.endT, limited[0].t + 0.1), cx: limited[0].cx });
  return limited;
}

/**
 * Compute the reframe plan for [start,end] of a video.
 * Returns crop geometry + keyframes (in source pixels) for the render step.
 */
export async function planReframe(
  videoPath: string,
  sourceW: number,
  sourceH: number,
  start: number,
  end: number,
  aspect: '9:16' | '1:1' | '16:9',
  speech: { start: number; end: number }[] = []
): Promise<ReframePlan> {
  const rf = getSettings('reframe');
  const target = aspectSize(aspect, sourceH);
  // Crop is at source resolution, keeping full source height (or width for wider targets).
  let cropW: number;
  let cropH: number;
  if (aspect === '9:16' || aspect === '1:1') {
    cropH = sourceH;
    cropW = Math.min(sourceW, Math.round(sourceH * (target.w / target.h)));
  } else {
    cropW = sourceW;
    cropH = Math.min(sourceH, Math.round(sourceW * (target.h / target.w)));
  }
  const fallbackCx = sourceW / 2;

  if (!rf.face_tracking) {
    return { aspect, cropW, cropH, frames: [{ t: 0, cx: fallbackCx }], usedTracking: false };
  }

  const points = await trackFaces(videoPath, start, end, rf.sample_interval, speech);
  if (points.length === 0) {
    logger.info('VIDEO', `no faces found in ${path.basename(videoPath)} ${start}-${end}s, using static center crop`);
    return { aspect, cropW, cropH, frames: [{ t: 0, cx: fallbackCx }], usedTracking: false };
  }

  const normalized = points.map((p) => ({ t: p.t - start, cx: p.cx * sourceW }));
  // clamp centers so the crop box stays inside the frame
  const half = cropW / 2;
  const clamped: TrackPoint[] = normalized.map((p) => ({ t: p.t, cx: Math.min(sourceW - half, Math.max(half, p.cx)) }));
  const frames = smoothTrack(clamped, {
    window: rf.smoothing_window,
    maxSpeed: rf.max_speed,
    deadzone: rf.deadzone,
    fallbackCx,
    startT: 0,
    endT: end - start,
    jumpPx: cropW / 2,
  });
  return { aspect, cropW, cropH, frames, usedTracking: true };
}

function trackFaces(videoPath: string, start: number, end: number, interval: number, speech: { start: number; end: number }[]): Promise<TrackPoint[]> {
  return new Promise((resolve, reject) => {
    const script = path.join(config.root, 'scripts', 'track_faces.py');
    const args = [
      script, videoPath, '--start', String(start), '--end', String(end), '--interval', String(interval),
    ];
    // transcript windows tell the tracker when anyone is speaking, so it only
    // switches faces on actual speech instead of guessing from silence
    if (speech.length) args.push('--speech', speech.map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(','));
    const child = spawn(config.python, args);
    const points: TrackPoint[] = [];
    let buf = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'point') points.push({ t: obj.t, cx: obj.cx });
        } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    // A crashed tracker is not "no faces found": fail the render instead of
    // silently shipping a centered crop. Exit 0 with no points is still a
    // legitimate no-face video and falls back to the static crop above.
    child.on('error', (e) => {
      logger.warn('VIDEO', `face tracker unavailable: ${e.message}`);
      reject(new Error(`face tracker could not run (${e.message}); fix python/opencv or disable face tracking in settings`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = err.trim().split('\n').filter(Boolean).pop() ?? `exit ${code}`;
        logger.warn('VIDEO', `face tracker exited ${code}: ${err.slice(-300)}`);
        reject(new Error(`face tracker crashed (${detail}); fix python/opencv or disable face tracking in settings`));
      }
      resolve(points);
    });
  });
}

/**
 * Build the FFmpeg crop expression + x position expression from keyframes.
 * Simplifies to a static crop when there's a single keyframe.
 */
export function cropFilter(plan: ReframePlan, outputSize: { w: number; h: number }): { crop: string; x: string } {
  const crop = `crop=${plan.cropW}:${plan.cropH}`;
  if (plan.frames.length <= 1) {
    const x = Math.round(Math.min(plan.cropW ? plan.frames[0].cx - plan.cropW / 2 : 0, 1e9));
    return { crop, x: String(Math.max(0, x)) };
  }
  // Build cascaded if() expression on t.
  const f = plan.frames;
  let expr = String(Math.max(0, Math.round(f[f.length - 1].cx - plan.cropW / 2)));
  for (let i = f.length - 2; i >= 0; i--) {
    const x0 = Math.max(0, Math.round(f[i].cx - plan.cropW / 2));
    const x1 = Math.max(0, Math.round(f[i + 1].cx - plan.cropW / 2));
    const t0 = f[i].t;
    const t1 = f[i + 1].t;
    const span = Math.max(0.001, t1 - t0);
    const lerp = `(${x0}+(${x1}-${x0})*(t-${t0.toFixed(3)})/${span.toFixed(3)})`;
    expr = `if(lt(t,${t1.toFixed(3)}),${lerp},${expr})`;
  }
  // commas separate filters in a -vf chain; escape them so the expression
  // stays a single crop argument
  return { crop, x: expr.replace(/,/g, '\\,') };
}
