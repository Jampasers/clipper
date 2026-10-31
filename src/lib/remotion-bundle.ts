/* Shared Remotion bundling + still rendering (used by caption overlays and the
   watermark SVG rasterizer). One bundle, cached in-process. */
import path from 'node:path';
import fs from 'node:fs';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, getCompositions, renderMedia, renderStill } from '@remotion/renderer';
import { ROOT } from '../config.js';
import { logger } from './log.js';

let bundleCache: Promise<string> | null = null;

export async function bundleUrl(): Promise<string> {
  if (!bundleCache) {
    bundleCache = bundle({ entryPoint: path.join(ROOT, 'remotion', 'index.tsx') }).catch((err) => {
      bundleCache = null; // allow a retry on the next render
      throw err;
    });
  }
  return bundleCache;
}

export { ensureBrowser, getCompositions, renderMedia, renderStill };

/**
 * Rasterize sanitized SVG markup to a transparent PNG via headless Chrome.
 * Throws on failure — the caller must treat the upload as rejected.
 */
export async function rasterizeSvgToPng(svgContent: string, outPath: string, width: number, height: number): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await ensureBrowser();
  const serveUrl = await bundleUrl();
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svgContent, 'utf8').toString('base64')}`;
  const inputProps = { dataUri, width, height };
  const comps = await getCompositions(serveUrl, { inputProps });
  const comp = comps.find((c) => c.id === 'WatermarkRaster');
  if (!comp) throw new Error('WatermarkRaster composition not found');
  await renderStill({
    composition: comp,
    serveUrl,
    inputProps,
    output: outPath,
    imageFormat: 'png',
    overwrite: true,
  });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) {
    throw new Error('SVG rasterization produced an empty image');
  }
  logger.info('CAPTION', `svg rasterized: ${path.basename(outPath)} (${width}x${height})`);
}
