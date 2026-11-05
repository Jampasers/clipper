import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { q } from '../lib/sqlite.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { probeVideo } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { safeExtension } from './assets.js';

/**
 * Design asset library: images, logos, backgrounds, textures, illustrations and
 * fonts usable by DesignDocuments. Files live on disk under storage/assets/design;
 * SQLite keeps metadata only. Layers never store paths — they reference library
 * asset ids which are resolved here on the server.
 */

export const DESIGN_ASSET_DIR = 'design';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const FONT_EXTS = new Set(['.ttf', '.otf', '.woff2']);
export const ASSET_KINDS = ['image', 'logo', 'background', 'texture', 'illustration', 'font'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface DesignAssetRow {
  id: string;
  name: string;
  file_path: string;
  thumbnail_path: string | null;
  mime: string;
  kind: AssetKind;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  tags: string | null;
  source: 'upload' | 'generated' | 'library';
  generator: string | null;
  prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class AssetReferenceError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'AssetReferenceError';
  }
}

export function designAssetDir(): string {
  const d = path.join(config.dirs.assets, DESIGN_ASSET_DIR);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function magicOk(file: string, ext: string): boolean {
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (ext === '.png') return buf.subarray(0, 4).toString('hex') === '89504e47';
  if (ext === '.jpg' || ext === '.jpeg') return buf[0] === 0xff && buf[1] === 0xd8;
  if (ext === '.webp') return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === '.gif') return buf.subarray(0, 3).toString('ascii') === 'GIF';
  if (ext === '.ttf') return buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00;
  if (ext === '.otf') return buf.subarray(0, 4).toString('ascii') === 'OTTO';
  if (ext === '.woff2') return buf.subarray(0, 4).toString('ascii') === 'wOF2';
  return false;
}

function mimeFor(ext: string): string {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

/* ---------------- CRUD ---------------- */

export function listDesignAssets(opts: { kind?: string; q?: string; enabledOnly?: boolean } = {}): DesignAssetRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.enabledOnly) where.push('enabled = 1');
  if (opts.kind) {
    where.push('kind = ?');
    args.push(opts.kind);
  }
  if (opts.q) {
    where.push('(name LIKE ? OR tags LIKE ?)');
    args.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const sql = `SELECT * FROM design_assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`;
  return q.all<DesignAssetRow>(sql, ...args);
}

export function getDesignAsset(id: string): DesignAssetRow | undefined {
  return q.get<DesignAssetRow>('SELECT * FROM design_assets WHERE id = ?', id);
}

/** Resolve a library asset id to a ready-to-serve row (file must exist). */
export function resolveDesignAsset(id: string): DesignAssetRow | undefined {
  const row = getDesignAsset(id);
  if (!row || !row.enabled) return undefined;
  if (!fs.existsSync(row.file_path)) return undefined;
  return row;
}

export interface CreateAssetMeta {
  name?: string;
  kind?: AssetKind;
  tags?: string;
  source?: 'upload' | 'generated' | 'library';
  generator?: string | null;
  prompt?: string | null;
}

export async function createDesignAsset(tmpPath: string, originalName: string, meta: CreateAssetMeta = {}): Promise<DesignAssetRow> {
  const kind: AssetKind = meta.kind && ASSET_KINDS.includes(meta.kind) ? meta.kind : 'image';
  const allowed = kind === 'font' ? FONT_EXTS : IMAGE_EXTS;
  const ext = safeExtension(originalName, allowed);
  const stat = fs.statSync(tmpPath);
  if (stat.size <= 0) throw new Error('uploaded file is empty');
  const maxBytes = getSettings('design').max_asset_bytes;
  if (stat.size > maxBytes) throw new Error(`file too large (max ${Math.round(maxBytes / 1e6)}MB)`);
  if (!magicOk(tmpPath, ext)) throw new Error(`file content does not match ${ext} (bad magic bytes)`);

  const id = nanoid(10);
  const filePath = path.join(designAssetDir(), `${id}${ext}`);
  fs.copyFileSync(tmpPath, filePath);

  let width: number | null = null;
  let height: number | null = null;
  if (kind !== 'font') {
    const probe = await probeVideo(filePath).catch(() => null);
    if (!probe || !probe.hasVideo || !probe.width) {
      fs.rmSync(filePath, { force: true });
      throw new Error('not a decodable image (ffprobe could not read it)');
    }
    width = probe.width;
    height = probe.height;
  }
  try { fs.rmSync(tmpPath, { force: true }); } catch { /* moved */ }

  q.run(
    `INSERT INTO design_assets (id, name, file_path, mime, kind, width, height, size_bytes, tags, source, generator, prompt, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    id,
    String(meta.name ?? path.parse(originalName).name).slice(0, 120) || `asset-${id}`,
    filePath,
    mimeFor(ext),
    kind,
    width,
    height,
    stat.size,
    meta.tags ?? null,
    meta.source ?? 'upload',
    meta.generator ?? null,
    meta.prompt ?? null
  );
  logger.info('DESIGN', `design asset created: ${id} (${kind}, ${path.basename(filePath)})`);
  return getDesignAsset(id)!;
}

/** Register an already-generated file (image provider output) into the library. */
export async function registerGeneratedAsset(filePath: string, meta: { name: string; mime: string; prompt?: string; generator?: string; kind?: AssetKind }): Promise<DesignAssetRow> {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`generated file type ${ext || '(none)'} is not a supported image`);
  }
  return createDesignAsset(filePath, `generated${ext}`, {
    name: meta.name.slice(0, 120),
    kind: meta.kind ?? 'image',
    source: 'generated',
    generator: meta.generator ?? null,
    prompt: meta.prompt ?? null,
  });
}

export function updateDesignAsset(id: string, patch: Partial<DesignAssetRow>): DesignAssetRow | undefined {
  const allowed: Partial<Record<keyof DesignAssetRow, unknown>> = {};
  if (typeof patch.name === 'string' && patch.name.trim()) allowed.name = patch.name.trim().slice(0, 120);
  if (typeof patch.tags === 'string' || patch.tags === null) allowed.tags = patch.tags ? String(patch.tags).slice(0, 300) : null;
  if (patch.enabled !== undefined) allowed.enabled = patch.enabled ? 1 : 0;
  if (patch.kind && ASSET_KINDS.includes(patch.kind)) allowed.kind = patch.kind;
  const sets = Object.keys(allowed);
  if (!sets.length) return getDesignAsset(id);
  q.run(
    `UPDATE design_assets SET ${sets.map((s) => `${s} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...sets.map((s) => allowed[s as keyof DesignAssetRow]),
    id
  );
  return getDesignAsset(id);
}

/** Which saved documents/templates reference this asset id (reference-safe delete). */
export function assetReferences(assetId: string): { designs: string[]; templates: string[] } {
  const needle = `%"assetId":"${assetId}"%`;
  const designs = q.all<{ id: string; name: string }>(
    'SELECT id, name FROM design_documents WHERE document LIKE ? LIMIT 20',
    needle
  );
  const templates = q.all<{ id: string; name: string }>(
    'SELECT id, name FROM design_templates WHERE document LIKE ? LIMIT 20',
    needle
  );
  return { designs: designs.map((d) => d.name || d.id), templates: templates.map((t) => t.name || t.id) };
}

export function deleteDesignAsset(id: string, force = false): boolean {
  const row = getDesignAsset(id);
  if (!row) return false;
  const refs = assetReferences(id);
  if (!force && (refs.designs.length || refs.templates.length)) {
    throw new AssetReferenceError(
      `asset is used by ${refs.designs.length} design(s)${refs.designs.length ? ` (${refs.designs.slice(0, 3).join(', ')})` : ''}` +
        `${refs.templates.length ? ` and ${refs.templates.length} template(s)` : ''}; delete those first or pass force=true`
    );
  }
  if (fs.existsSync(row.file_path)) {
    try { fs.rmSync(row.file_path, { force: true }); } catch (e) { logger.warn('DESIGN', `could not remove asset file: ${(e as Error).message}`); }
  }
  if (row.thumbnail_path && fs.existsSync(row.thumbnail_path)) {
    try { fs.rmSync(row.thumbnail_path, { force: true }); } catch { /* best effort */ }
  }
  q.run('DELETE FROM design_assets WHERE id = ?', id);
  return true;
}

/* ---------------- fonts ---------------- */

export interface FontInfo {
  family: string;
  assetId: string;
  mime: string;
  fileName: string;
}

export function listDesignFonts(): FontInfo[] {
  return q
    .all<DesignAssetRow>("SELECT * FROM design_assets WHERE kind = 'font' AND enabled = 1 ORDER BY name ASC")
    .map((row) => ({
      family: path.parse(row.file_path).name,
      assetId: row.id,
      mime: row.mime,
      fileName: path.basename(row.file_path),
    }));
}

/** Font family -> file for the renderer's @font-face embedding. */
export function resolveFont(family: string): { filePath: string; mime: string } | undefined {
  const fonts = q.all<DesignAssetRow>("SELECT * FROM design_assets WHERE kind = 'font' AND enabled = 1");
  const target = family.trim().toLowerCase();
  const row = fonts.find((f) => path.parse(f.file_path).name.toLowerCase() === target) ?? fonts.find((f) => path.parse(f.file_path).name.toLowerCase().replace(/[-_]/g, '') === target.replace(/[-_]/g, ''));
  if (!row || !fs.existsSync(row.file_path)) return undefined;
  return { filePath: row.file_path, mime: row.mime };
}
