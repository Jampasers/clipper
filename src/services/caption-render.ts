/* Renders the transparent caption overlay for one clip via Remotion (headless Chrome -> ProRes 4444). */
import path from 'node:path';
import fs from 'node:fs';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, getCompositions, renderMedia } from '@remotion/renderer';
import { config, ROOT } from '../config.js';
import type { SubtitlePreset } from '../lib/settings.js';
import type { SubtitleEvent } from './subtitles.js';
import { logger } from '../lib/log.js';

export interface CaptionRenderOpts {
  clipId: string;
  events: SubtitleEvent[];
  preset: SubtitlePreset;
  emphasis: { enabled: boolean; color: string; scale_percent: number; bold: boolean };
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

let bundleCache: Promise<string> | null = null;

async function bundleUrl(): Promise<string> {
  if (!bundleCache) {
    bundleCache = bundle({ entryPoint: path.join(ROOT, 'remotion', 'index.tsx') }).catch((err) => {
      bundleCache = null; // allow a retry on the next render
      throw err;
    });
  }
  return bundleCache;
}

export async function renderCaptionOverlay(o: CaptionRenderOpts): Promise<string> {
  const dir = path.join(config.dirs.temp, o.clipId);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'caption.mov');
  const inputProps = {
    width: o.width,
    height: o.height,
    fps: o.fps,
    durationInFrames: Math.max(1, Math.ceil(o.durationSec * o.fps)),
    events: o.events,
    preset: o.preset,
    emphasis: o.emphasis,
  };
  await ensureBrowser(); // downloads Chrome Headless Shell on first use
  const serveUrl = await bundleUrl();
  const comps = await getCompositions(serveUrl, { inputProps });
  const comp = comps.find((c) => c.id === 'CaptionOverlay');
  if (!comp) throw new Error('CaptionOverlay composition not found');
  await renderMedia({
    composition: comp,
    serveUrl,
    codec: 'prores',
    proResProfile: '4444',
    imageFormat: 'png',
    pixelFormat: 'yuva444p10le',
    outputLocation: out,
    inputProps,
  });
  logger.info('CAPTION', `overlay ready: ${o.clipId}/caption.mov (${o.events.length} events, ${o.width}x${o.height})`);
  return out;
}
