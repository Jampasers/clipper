import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { rasterizeSvgToImage } from '../lib/remotion-bundle.js';
import { logger } from '../lib/log.js';
import type { DesignDocument } from './document.js';
import { renderDocumentSvg } from './render.js';

/**
 * Real design exports. Every format performs an actual render:
 *  - SVG: the canonical document render, fully embedded (assets as data URIs).
 *  - PNG/JPG: headless-Chromium rasterization of that SVG.
 *  - PDF: a valid single-page PDF (A-series page box at 72dpi = design pixels)
 *    embedding the JPEG raster via DCTDecode.
 * There are no fake exports: callers get a file that exists and decodes.
 */

export const EXPORT_FORMATS = ['png', 'jpg', 'svg', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportResult {
  format: ExportFormat;
  filePath: string;
  fileName: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  format: ExportFormat;
  scale: number;
  quality: number;
  /** resolve a design asset to its file on disk (server-side only) */
  resolveAssetFile: (libraryAssetId: string) => { filePath: string; mime: string } | null;
  /** resolve a custom font family to its file */
  resolveFontFile?: (family: string) => { filePath: string; mime: string } | null;
  outDir?: string;
  baseName?: string;
}

function clampDim(n: number): number { return Math.max(16, Math.min(10000, Math.round(n))); }

function dataUri(filePath: string, mime: string): string {
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

export function renderForExport(doc: DesignDocument, opts: Pick<ExportOptions, 'resolveAssetFile' | 'resolveFontFile'>): string {
  return renderDocumentSvg(doc, {
    mode: 'embed',
    assetHref: (a) => {
      const f = opts.resolveAssetFile(a.assetId);
      return f ? dataUri(f.filePath, f.mime) : null;
    },
    fontHref: (family) => {
      const f = opts.resolveFontFile?.(family);
      if (!f) return null;
      return { href: dataUri(f.filePath, f.mime), mime: f.mime };
    },
  });
}

export function exportsDir(): string {
  const d = path.join(config.dirs.designs, 'exports');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function thumbsDir(): string {
  const d = path.join(config.dirs.designs, 'thumbs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Minimal but valid single-page PDF embedding a JPEG (DCTDecode). */
export function writePdfFromJpeg(jpegPath: string, outPath: string, pageW: number, pageH: number, imgW: number, imgH: number): number {
  const jpeg = fs.readFileSync(jpegPath);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];

  const push = (piece: string | Uint8Array) => {
    const buf = typeof piece === 'string' ? encoder.encode(piece) : piece;
    parts.push(buf);
    offset += buf.length;
  };
  const record = () => offsets.push(offset);

  push('%PDF-1.4\n');
  record(); // obj 1
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  record(); // obj 2
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  record(); // obj 3
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  record(); // obj 4 (image)
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  record(); // obj 5 (content)
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const xrefStart = offset;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  fs.writeFileSync(outPath, Buffer.concat(parts));
  return offset;
}

export async function exportDesign(doc: DesignDocument, opts: ExportOptions): Promise<ExportResult> {
  const scale = Math.max(0.25, Math.min(4, opts.scale || 1));
  const outW = clampDim(doc.canvas.width * scale);
  const outH = clampDim(doc.canvas.height * scale);
  const dir = opts.outDir ?? exportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = (opts.baseName ?? `${doc.id}-r${doc.revision}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'design';
  const started = Date.now();

  if (opts.format === 'svg') {
    const svg = renderForExport(doc, opts);
    const filePath = path.join(dir, `${base}.svg`);
    fs.writeFileSync(filePath, svg, 'utf8');
    logger.info('DESIGN', `export svg: ${path.basename(filePath)} (${Buffer.byteLength(svg)}B in ${Date.now() - started}ms)`);
    return { format: 'svg', filePath, fileName: path.basename(filePath), mime: 'image/svg+xml', bytes: Buffer.byteLength(svg), width: doc.canvas.width, height: doc.canvas.height };
  }

  const svg = renderForExport(doc, opts);
  if (opts.format === 'png' || opts.format === 'jpg') {
    const ext = opts.format === 'png' ? 'png' : 'jpg';
    const filePath = path.join(dir, `${base}.${ext}`);
    await rasterizeSvgToImage(svg, filePath, outW, outH, opts.format === 'png' ? 'png' : 'jpeg', opts.quality);
    const bytes = fs.statSync(filePath).size;
    if (bytes < 100) throw new Error(`export produced an implausibly small ${ext} file (${bytes}B)`);
    logger.info('DESIGN', `export ${opts.format}: ${path.basename(filePath)} (${outW}x${outH}, ${bytes}B in ${Date.now() - started}ms)`);
    return { format: opts.format, filePath, fileName: path.basename(filePath), mime: opts.format === 'png' ? 'image/png' : 'image/jpeg', bytes, width: outW, height: outH };
  }

  // pdf: rasterize to jpeg, embed
  const jpegPath = path.join(config.dirs.temp, `${base}-pdf.jpg`);
  try {
    await rasterizeSvgToImage(svg, jpegPath, outW, outH, 'jpeg', Math.max(60, Math.min(98, opts.quality)));
    const filePath = path.join(dir, `${base}.pdf`);
    writePdfFromJpeg(jpegPath, filePath, outW, outH, outW, outH);
    const bytes = fs.statSync(filePath).size;
    if (bytes < 200) throw new Error('export produced an implausibly small PDF');
    logger.info('DESIGN', `export pdf: ${path.basename(filePath)} (${outW}x${outH}, ${bytes}B in ${Date.now() - started}ms)`);
    return { format: 'pdf', filePath, fileName: path.basename(filePath), mime: 'application/pdf', bytes, width: outW, height: outH };
  } finally {
    try { fs.rmSync(jpegPath, { force: true }); } catch { /* temp */ }
  }
}

/** Save/refresh the editor thumbnail (small PNG) for lists. */
export async function writeThumbnail(doc: DesignDocument, resolveAssetFile: ExportOptions['resolveAssetFile'], maxSide = 480): Promise<string> {
  const savedScale = doc.settings?.export?.scale ?? 1;
  const svg = renderForExport(doc, { resolveAssetFile });
  const ratio = doc.canvas.width / doc.canvas.height;
  const w = ratio >= 1 ? maxSide : Math.round(maxSide * ratio);
  const h = ratio >= 1 ? Math.round(maxSide / ratio) : maxSide;
  const out = path.join(thumbsDir(), `${doc.id}-r${doc.revision}.png`);
  await rasterizeSvgToImage(svg, out, clampDim(w), clampDim(h), 'png');
  void savedScale;
  return out;
}
