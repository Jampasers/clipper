/* Renders the transparent overlay for one clip via Remotion (headless Chrome
 * -> ProRes 4444). In adaptive mode the CreativeOverlay composition carries
 * the EDL graphics (titles/lower-thirds/stat cards/callouts/progress bar)
 * plus the same captions; otherwise the plain CaptionOverlay is used. */
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import type { SubtitlePreset } from '../lib/settings.js';
import type { SubtitleEvent } from './subtitles.js';
import type { Edl } from './edl.js';
import { bundleUrl, ensureBrowser, getCompositions, renderMedia } from '../lib/remotion-bundle.js';
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
  /** ai | bold | karaoke | kinetic */
  mode?: string;
  animations?: boolean;
  /** adaptive creative plan; when set, renders graphics + captions together */
  creative?: { edl: Edl } | null;
}

export async function renderCaptionOverlay(o: CaptionRenderOpts): Promise<string> {
  const dir = path.join(config.dirs.temp, o.clipId);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'caption.mov');
  const frameBase = {
    width: o.width,
    height: o.height,
    fps: o.fps,
    durationInFrames: Math.max(1, Math.ceil(o.durationSec * o.fps)),
  };
  const captionProps = o.events.length
    ? {
        events: o.events,
        preset: o.preset,
        emphasis: o.emphasis,
        mode: o.mode ?? 'ai',
        animations: o.animations ?? true,
      }
    : null;
  const inputProps = o.creative
    ? {
        ...frameBase,
        captions: captionProps,
        graphics: {
          accentColor: o.creative.edl.style.accentColor,
          progressBar: o.creative.edl.style.progressBar,
          titles: o.creative.edl.titles,
          lowerThirds: o.creative.edl.lowerThirds,
          statCards: o.creative.edl.statCards,
          callouts: o.creative.edl.callouts,
        },
      }
    : { ...frameBase, ...(captionProps ?? { events: [], preset: o.preset, emphasis: o.emphasis, mode: 'ai', animations: true }) };
  const compId = o.creative ? 'CreativeOverlay' : 'CaptionOverlay';

  await ensureBrowser(); // downloads Chrome Headless Shell on first use
  const serveUrl = await bundleUrl();
  const timeoutInMilliseconds = 120_000; // cold Chrome launch on a busy box can exceed the 25s default
  const comps = await getCompositions(serveUrl, { inputProps, timeoutInMilliseconds });
  const comp = comps.find((c) => c.id === compId);
  if (!comp) throw new Error(`${compId} composition not found`);
  await renderMedia({
    composition: comp,
    serveUrl,
    codec: 'prores',
    proResProfile: '4444',
    imageFormat: 'png',
    pixelFormat: 'yuva444p10le',
    outputLocation: out,
    inputProps,
    timeoutInMilliseconds,
  });
  logger.info(
    'CAPTION',
    `overlay ready: ${o.clipId}/caption.mov (${o.events.length} events, ${o.width}x${o.height}, comp=${compId})`
  );
  return out;
}
