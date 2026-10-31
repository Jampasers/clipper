import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { q } from '../lib/sqlite.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { probeVideo } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { rasterizeSvgToPng } from '../lib/remotion-bundle.js';
import type { WatermarkPosition, WatermarkOverride, RenderOptions } from './render-options.js';

/**
 * Asset manager: watermark images (png/webp/svg) and background music files.
 * Files live on disk under storage/assets — SQLite only keeps metadata + paths
 * (same storage model as videos in this repo).
 */

export const WATERMARK_DIR = 'watermarks';
export const MUSIC_DIR = 'music';

export interface WatermarkRow {
  id: string;
  name: string;
  file_path: string;
  source_path: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  enabled: number;
  default_position: WatermarkPosition;
  width_percent: number;
  opacity: number;
  margin: number;
  x: number | null;
  y: number | null;
  created_at: string;
  updated_at: string;
}

export interface MusicRow {
  id: string;
  name: string;
  file_path: string;
  mime: string;
  mood: string | null;
  genre: string | null;
  energy: number;
  bpm: number | null;
  duration: number | null;
  license: string | null;
  attribution: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export function watermarkDir(): string {
  const d = path.join(config.dirs.assets, WATERMARK_DIR);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function musicDir(): string {
  const d = path.join(config.dirs.assets, MUSIC_DIR);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ---------------- validation helpers ---------------- */

const WATERMARK_EXTS = new Set(['.png', '.webp', '.svg']);
const MUSIC_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus']);
export const WATERMARK_MAX_BYTES = 5 * 1024 * 1024;
export const MUSIC_MAX_BYTES = 60 * 1024 * 1024;

/** Reject filenames / mimetype → single extension, no traversal possible. */
export function safeExtension(originalName: string, allowed: Set<string>): string {
  const ext = path.extname(originalName.toLowerCase()).replace(/[^.a-z0-9]/g, '');
  if (!allowed.has(ext)) throw new Error(`unsupported file type "${ext || '(none)'}"; allowed: ${[...allowed].join(', ')}`);
  return ext;
}

function magicBytesOk(file: string, ext: string): boolean {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (ext === '.png') return buf.subarray(0, 4).toString('hex') === '89504e47';
  if (ext === '.webp') return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return true;
}

/* ---------------- SVG sanitization ---------------- */

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'rect', 'line', 'ellipse', 'polygon', 'polyline', 'text', 'tspan',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'filter',
  'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'use', 'symbol', 'style',
]);

const ALLOWED_ATTRS = new Set([
  'id', 'class', 'd', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'viewbox', 'points', 'transform', 'clip-path', 'mask',
  'style', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline',
  'gradientunits', 'gradienttransform', 'offset', 'stop-color', 'stop-opacity', 'xmlns', 'preserveaspectratio', 'role', 'aria-hidden',
]);

const DANGEROUS_ATTR_VALUE = /(javascript:|data:|https?:)?\/\//i;

/**
 * Strict allow-list sanitizer: unknown tags/attributes reject the file instead
 * of being stripped (a stripped unknown construct can still be dangerous).
 */
export function sanitizeSvg(content: string): string {
  const cleaned = content.replace(/^\uFEFF/, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<(script|foreignobject|iframe|embed|object|animate|set|handler)\b/i.test(cleaned)) {
    throw new Error('SVG contains disallowed elements (script/foreignObject/animation)');
  }
  if (/<!DOCTYPE/i.test(cleaned) || /(javascript:|data:text\/html)/i.test(cleaned)) {
    throw new Error('SVG contains disallowed references');
  }
  const tagRe = /<\/?\s*([A-Za-z][\w-]*(?::\w+)?)((?:"[^"]*"|'[^']*'|[^>])*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const rawTag = m[1];
    const tag = rawTag.replace(/^[\w-]+:/, '').toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) throw new Error(`SVG element "<${rawTag}>" is not allowed`);
    const attrs = m[2];
    const attrRe = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrs)) !== null) {
      const name = am[1].replace(/^[\w-]+:/, '').toLowerCase();
      const value = am[3] ?? am[4] ?? '';
      if (!ALLOWED_ATTRS.has(name)) throw new Error(`SVG attribute "${am[1]}" is not allowed`);
      if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) throw new Error('external SVG references are not allowed');
      if (DANGEROUS_ATTR_VALUE.test(value) && (name === 'href' || name === 'xlink:href')) throw new Error('external SVG references are not allowed');
    }
  }
  if (!/<svg[\s>]/i.test(cleaned)) throw new Error('file is not an SVG document');
  return cleaned;
}

/** Extract intrinsic size from width/height or viewBox; fallback 512. */
export function svgDimensions(content: string): { width: number; height: number } {
  const w = /<svg[^>]*\bwidth\s*=\s*["']?([\d.]+)\b/i.exec(content);
  const h = /<svg[^>]*\bheight\s*=\s*["']?([\d.]+)\b/i.exec(content);
  const vb = /<svg[^>]*\bviewBox\s*=\s*["']?([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(content);
  const clampDim = (n: number) => Math.min(2048, Math.max(8, Math.round(n)));
  let width = w ? parseFloat(w[1]) : 0;
  let height = h ? parseFloat(h[1]) : 0;
  if ((!width || !height) && vb) {
    width = width || parseFloat(vb[3]);
    height = height || parseFloat(vb[4]);
  }
  const ratio = width && height ? height / width : 1;
  if (!width) width = 512;
  if (!height) height = Math.max(8, Math.round(width * ratio));
  // cap the raster size so a huge viewBox cannot allocate GBs in Chrome
  const scale = Math.min(1, 1024 / Math.max(width, height));
  return { width: clampDim(width * scale), height: clampDim(height * scale) };
}

/* ---------------- watermark CRUD ---------------- */

export function listWatermarks(enabledOnly = false): WatermarkRow[] {
  return q.all<WatermarkRow>(
    `SELECT * FROM watermarks ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY created_at ASC`
  );
}

export function getWatermark(id: string): WatermarkRow | undefined {
  return q.get<WatermarkRow>('SELECT * FROM watermarks WHERE id = ?', id);
}

export async function createWatermark(tmpPath: string, originalName: string, defaults?: Partial<WatermarkRow>): Promise<WatermarkRow> {
  const ext = safeExtension(originalName, WATERMARK_EXTS);
  const stat = fs.statSync(tmpPath);
  if (stat.size <= 0) throw new Error('uploaded file is empty');
  if (stat.size > WATERMARK_MAX_BYTES) throw new Error(`file too large (max ${Math.round(WATERMARK_MAX_BYTES / 1e6)}MB)`);
  if (!magicBytesOk(tmpPath, ext)) throw new Error(`file content does not match .${ext} (bad magic bytes)`);

  const id = nanoid(10);
  const dir = watermarkDir();
  const wm = getSettings('watermark');

  let filePath: string;
  let sourcePath: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let mime: string;

  if (ext === '.svg') {
    const content = fs.readFileSync(tmpPath, 'utf8');
    const sanitized = sanitizeSvg(content);
    const { width: w, height: h } = svgDimensions(sanitized);
    sourcePath = path.join(dir, `${id}.svg`);
    filePath = path.join(dir, `${id}.png`);
    fs.writeFileSync(sourcePath, sanitized, 'utf8');
    await rasterizeSvgToPng(sanitized, filePath, w, h);
    width = w;
    height = h;
    mime = 'image/png';
  } else {
    filePath = path.join(dir, `${id}${ext}`);
    fs.copyFileSync(tmpPath, filePath);
   mime = ext === '.png' ? 'image/png' : 'image/webp';
    const probe = await probeVideo(filePath).catch(() => null);
    if (!probe || !probe.hasVideo || !probe.width) {
      fs.rmSync(filePath, { force: true });
      throw new Error('not a decodable image (ffprobe could not read it)');
    }
    width = probe.width;
    height = probe.height;
  }
  try { fs.rmSync(tmpPath, { force: true }); } catch { /* temp already moved */ }

  q.run(
    `INSERT INTO watermarks (id, name, file_path, source_path, mime, width, height, enabled, default_position, width_percent, opacity, margin, x, y)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    String(defaults?.name ?? path.parse(originalName).name.replace(/\.[^.]+$/, '')).slice(0, 80) || `watermark-${id}`,
    filePath,
    sourcePath,
    mime,
    width,
    height,
    defaults?.enabled ?? 1,
    (defaults?.default_position as WatermarkPosition) ?? wm.default_position,
    defaults?.width_percent ?? wm.default_width_percent,
    defaults?.opacity ?? wm.default_opacity,
    defaults?.margin ?? wm.default_margin,
    defaults?.x ?? null,
    defaults?.y ?? null
  );
  logger.info('SYSTEM', `watermark created: ${id} (${path.basename(filePath)})`);
  return getWatermark(id)!;
}

export function updateWatermark(id: string, patch: Partial<WatermarkRow>): WatermarkRow | undefined {
  const allowed: Partial<Record<keyof WatermarkRow, unknown>> = {};
  if (typeof patch.name === 'string') allowed.name = patch.name.slice(0, 80);
  if (patch.enabled !== undefined) allowed.enabled = patch.enabled ? 1 : 0;
  if (patch.default_position !== undefined) allowed.default_position = validatePosition(patch.default_position);
  if (patch.width_percent !== undefined) allowed.width_percent = clamp(patch.width_percent, 1, 100);
  if (patch.opacity !== undefined) allowed.opacity = clamp(patch.opacity, 0, 1);
  if (patch.margin !== undefined) allowed.margin = clamp(patch.margin, 0, 500);
  if (patch.x !== undefined) allowed.x = patch.x === null ? null : clamp(patch.x, 0, 100000);
  if (patch.y !== undefined) allowed.y = patch.y === null ? null : clamp(patch.y, 0, 100000);
  const sets = Object.keys(allowed);
  if (!sets.length) return getWatermark(id);
  q.run(
    `UPDATE watermarks SET ${sets.map((s) => `${s} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...sets.map((s) => allowed[s as keyof WatermarkRow]),
    id
  );
  return getWatermark(id);
}

export function deleteWatermark(id: string): boolean {
  const wm = getWatermark(id);
  if (!wm) return false;
  for (const f of [wm.file_path, wm.source_path]) {
    if (f && fs.existsSync(f)) {
      try { fs.rmSync(f, { force: true }); } catch (e) { logger.warn('SYSTEM', `could not remove watermark file: ${(e as Error).message}`); }
    }
  }
  q.run('DELETE FROM watermarks WHERE id = ?', id);
  return true;
}

export function validatePosition(p: unknown): WatermarkPosition {
  const ok: WatermarkPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'custom'];
  if (typeof p !== 'string' || !ok.includes(p as WatermarkPosition)) throw new Error(`invalid watermark position "${String(p)}"`);
  return p as WatermarkPosition;
}

function clamp(n: unknown, a: number, b: number): number {
  const v = Number(n);
  return Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));
}

/* ---------------- watermarks at render time ---------------- */

export interface WatermarkLayerSpec {
  asset: WatermarkRow;
  position: WatermarkPosition;
  x: number | null;
  y: number | null;
  widthPercent: number;
  opacity: number;
  margin: number;
}

/**
 * Resolve the watermarks that should render for this job. Per-render option
 * overrides apply only to this render — global watermark rows are never edited.
 * Invalid/missing assets are skipped with a logged error (render must not fail
 * because of branding).
 */
export function resolveWatermarkLayers(options: RenderOptions['watermark'], maxLayers = 5): WatermarkLayerSpec[] {
  const all = listWatermarks(true);
  const selected = options.ids.length ? options.ids.map((id) => all.find((w) => w.id === id)).filter((w): w is WatermarkRow => !!w) : all;
  const layers: WatermarkLayerSpec[] = [];
  for (const asset of selected.slice(0, maxLayers)) {
    if (!fs.existsSync(asset.file_path)) {
      logger.error('RENDER', `watermark ${asset.id} file missing: ${asset.file_path} — skipped`);
      continue;
    }
    const ov: WatermarkOverride = options.overrides?.[asset.id] ?? {};
    layers.push({
      asset,
      position: ov.position ?? (validatePositionSafe(asset.default_position) as WatermarkPosition),
      x: ov.x ?? asset.x,
      y: ov.y ?? asset.y,
      widthPercent: ov.widthPercent ?? asset.width_percent,
      opacity: ov.opacity ?? asset.opacity,
      margin: ov.margin ?? asset.margin,
    });
  }
  return layers;
}

function validatePositionSafe(p: string): string {
  try {
    return validatePosition(p);
  } catch {
    return 'bottom-right';
  }
}

/* ---------------- music library ---------------- */

export function listMusic(enabledOnly = false): MusicRow[] {
  return q.all<MusicRow>(`SELECT * FROM music_assets ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY name ASC`);
}

export function getMusic(id: string): MusicRow | undefined {
  return q.get<MusicRow>('SELECT * FROM music_assets WHERE id = ?', id);
}

export async function createMusic(tmpPath: string, originalName: string, meta: Partial<MusicRow> = {}): Promise<MusicRow> {
  const ext = safeExtension(originalName, MUSIC_EXTS);
  const stat = fs.statSync(tmpPath);
  if (stat.size <= 0) throw new Error('uploaded file is empty');
  if (stat.size > MUSIC_MAX_BYTES) throw new Error(`file too large (max ${Math.round(MUSIC_MAX_BYTES / 1e6)}MB)`);

  const id = nanoid(10);
  const dir = musicDir();
  const filePath = path.join(dir, `${id}${ext}`);
  fs.copyFileSync(tmpPath, filePath);
  let probe;
  try {
    probe = await probeVideo(filePath);
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    throw new Error(`not a decodable audio file: ${(e as Error).message.slice(0, 120)}`);
  }
  if (!probe.hasAudio) {
    fs.rmSync(filePath, { force: true });
    throw new Error('file has no audio stream');
  }
  try { fs.rmSync(tmpPath, { force: true }); } catch { /* temp already moved */ }

  q.run(
    `INSERT INTO music_assets (id, name, file_path, mime, mood, genre, energy, bpm, duration, license, attribution, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    String(meta.name ?? path.parse(originalName).name).slice(0, 80) || `music-${id}`,
    filePath,
    probe.acodec === 'mp3' ? 'audio/mpeg' : `audio/${ext.slice(1)}`,
    meta.mood ?? null,
    meta.genre ?? null,
    clamp(meta.energy ?? 3, 1, 5),
    meta.bpm ?? null,
    probe.duration,
    meta.license ?? null,
    meta.attribution ?? null,
    meta.enabled ?? 1
  );
  logger.info('SYSTEM', `music asset created: ${id} "${meta.name ?? originalName}" (${probe.duration?.toFixed(1)}s)`);
  return getMusic(id)!;
}

export function updateMusic(id: string, patch: Partial<MusicRow>): MusicRow | undefined {
  const allowed: Partial<Record<keyof MusicRow, unknown>> = {};
  if (typeof patch.name === 'string') allowed.name = patch.name.slice(0, 80);
  if (typeof patch.mood === 'string' || patch.mood === null) allowed.mood = patch.mood;
  if (typeof patch.genre === 'string' || patch.genre === null) allowed.genre = patch.genre;
  if (patch.energy !== undefined) allowed.energy = clamp(patch.energy, 1, 5);
  if (patch.bpm !== undefined) allowed.bpm = patch.bpm === null ? null : clamp(patch.bpm, 20, 400);
  if (typeof patch.license === 'string' || patch.license === null) allowed.license = patch.license;
  if (typeof patch.attribution === 'string' || patch.attribution === null) allowed.attribution = patch.attribution;
  if (patch.enabled !== undefined) allowed.enabled = patch.enabled ? 1 : 0;
  const sets = Object.keys(allowed);
  if (!sets.length) return getMusic(id);
  q.run(
    `UPDATE music_assets SET ${sets.map((s) => `${s} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...sets.map((s) => allowed[s as keyof MusicRow]),
    id
  );
  return getMusic(id);
}

export function deleteMusic(id: string): boolean {
  const m = getMusic(id);
  if (!m) return false;
  if (fs.existsSync(m.file_path)) {
    try { fs.rmSync(m.file_path, { force: true }); } catch (e) { logger.warn('SYSTEM', `could not remove music file: ${(e as Error).message}`); }
  }
  q.run('DELETE FROM music_assets WHERE id = ?', id);
  return true;
}
