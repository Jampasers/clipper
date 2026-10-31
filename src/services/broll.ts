import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { q } from '../lib/sqlite.js';
import { config } from '../config.js';
import { probeVideo } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { safeExtension } from './assets.js';
import type { BrollPlacement } from './edl.js';

/**
 * B-roll registry: user-owned video/image clips that can be placed over the
 * main footage. Only local, user-provided files are ever used — nothing is
 * downloaded and license/source metadata travels with every asset so renders
 * stay auditable. Unresolved placements are dropped with a warning, never
 * silently substituted with arbitrary web content.
 */

export const BROLL_DIR = 'broll';

export const BROLL_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
export const BROLL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const BROLL_MAX_VIDEO_BYTES = 120 * 1024 * 1024;
export const BROLL_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const BROLL_MIN_VIDEO_DURATION = 1;

export interface BrollRow {
  id: string;
  name: string;
  file_path: string;
  mime: string;
  kind: 'video' | 'image';
  width: number | null;
  height: number | null;
  duration: number | null;
  tags: string | null;
  source: string | null;
  license: string | null;
  attribution: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export function brollDir(): string {
  const d = path.join(config.dirs.assets, BROLL_DIR);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function magicOk(file: string, ext: string): boolean {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (ext === '.png') return buf.subarray(0, 4).toString('hex') === '89504e47';
  if (ext === '.jpg' || ext === '.jpeg') return buf[0] === 0xff && buf[1] === 0xd8;
  if (ext === '.webp') return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return true;
}

export function listBroll(enabledOnly = false): BrollRow[] {
  return q.all<BrollRow>(`SELECT * FROM broll_assets ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY name ASC`);
}

export function getBroll(id: string): BrollRow | undefined {
  return q.get<BrollRow>('SELECT * FROM broll_assets WHERE id = ?', id);
}

export function brollTags(asset: BrollRow): string[] {
  return String(asset.tags ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export async function createBroll(
  tmpPath: string,
  originalName: string,
  meta: Partial<Pick<BrollRow, 'name' | 'tags' | 'source' | 'license' | 'attribution'>> = {}
): Promise<BrollRow> {
  const ext = safeExtension(originalName, new Set([...BROLL_VIDEO_EXTS, ...BROLL_IMAGE_EXTS]));
  const stat = fs.statSync(tmpPath);
  if (stat.size <= 0) throw new Error('uploaded file is empty');
  const isImage = BROLL_IMAGE_EXTS.has(ext);
  const maxBytes = isImage ? BROLL_MAX_IMAGE_BYTES : BROLL_MAX_VIDEO_BYTES;
  if (stat.size > maxBytes) throw new Error(`file too large (max ${Math.round(maxBytes / 1e6)}MB)`);
  if (isImage && !magicOk(tmpPath, ext)) throw new Error(`file content does not match .${ext} (bad magic bytes)`);

  const id = nanoid(10);
  const filePath = path.join(brollDir(), `${id}${ext}`);
  fs.copyFileSync(tmpPath, filePath);
  let probe;
  try {
    probe = await probeVideo(filePath);
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    throw new Error(`not a decodable media file: ${(e as Error).message.slice(0, 120)}`);
  }
  if (!probe.hasVideo) {
    fs.rmSync(filePath, { force: true });
    throw new Error('file has no video stream');
  }
  const duration = isImage ? null : Math.round((probe.duration ?? 0) * 100) / 100;
  if (!isImage && (duration ?? 0) < BROLL_MIN_VIDEO_DURATION) {
    fs.rmSync(filePath, { force: true });
    throw new Error(`video b-roll must be at least ${BROLL_MIN_VIDEO_DURATION}s`);
  }
  try { fs.rmSync(tmpPath, { force: true }); } catch { /* temp already moved */ }

  q.run(
    `INSERT INTO broll_assets (id, name, file_path, mime, kind, width, height, duration, tags, source, license, attribution, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    String(meta.name ?? path.parse(originalName).name).slice(0, 80) || `broll-${id}`,
    filePath,
    isImage ? (ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg') : `video/${ext.slice(1)}`,
    isImage ? 'image' : 'video',
    probe.width || null,
    probe.height || null,
    duration,
    String(meta.tags ?? '').slice(0, 300) || null,
    String(meta.source ?? 'upload').slice(0, 120),
    meta.license ? String(meta.license).slice(0, 200) : null,
    meta.attribution ? String(meta.attribution).slice(0, 300) : null,
    1
  );
  logger.info('SYSTEM', `b-roll asset created: ${id} "${meta.name ?? originalName}" (${isImage ? 'image' : `${duration}s video`})`);
  return getBroll(id)!;
}

export function updateBroll(id: string, patch: Partial<BrollRow>): BrollRow | undefined {
  const allowed: Partial<Record<keyof BrollRow, unknown>> = {};
  if (typeof patch.name === 'string') allowed.name = patch.name.slice(0, 80);
  if (typeof patch.tags === 'string' || patch.tags === null) allowed.tags = patch.tags;
  if (typeof patch.source === 'string' || patch.source === null) allowed.source = patch.source;
  if (typeof patch.license === 'string' || patch.license === null) allowed.license = patch.license;
  if (typeof patch.attribution === 'string' || patch.attribution === null) allowed.attribution = patch.attribution;
  if (patch.enabled !== undefined) allowed.enabled = patch.enabled ? 1 : 0;
  const sets = Object.keys(allowed);
  if (!sets.length) return getBroll(id);
  q.run(
    `UPDATE broll_assets SET ${sets.map((s) => `${s} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...sets.map((s) => allowed[s as keyof BrollRow]),
    id
  );
  return getBroll(id);
}

export function deleteBroll(id: string): boolean {
  const b = getBroll(id);
  if (!b) return false;
  if (fs.existsSync(b.file_path)) {
    try { fs.rmSync(b.file_path, { force: true }); } catch (e) { logger.warn('SYSTEM', `could not remove b-roll file: ${(e as Error).message}`); }
  }
  q.run('DELETE FROM broll_assets WHERE id = ?', id);
  return true;
}

/* ---------------- context-aware search + scoring ---------------- */

export interface ScoredBroll {
  asset: BrollRow;
  score: number;
  reason: string;
}

const STOPWORDS = new Set(['dan', 'atau', 'the', 'and', 'for', 'with', 'this', 'that', 'yang', 'untuk', 'dari', 'ini', 'itu', 'di']);

function tokens(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Deterministic relevance scoring:
 *  - query tag/token overlap (strong)
 *  - asset name overlap
 *  - context transcript tokens vs asset tags (weak)
 *  - duration fit for video, licensed assets get a small bonus
 */
export function scoreBrollAssets(query: string, contextText: string, assets: BrollRow[], windowDuration: number): ScoredBroll[] {
  const qTokens = new Set(tokens(query));
  const ctxTokens = new Set(tokens(contextText));
  const scored: ScoredBroll[] = [];
  for (const asset of assets) {
    if (!asset.enabled) continue;
    if (!fs.existsSync(asset.file_path)) continue;
    const assetTokens = new Set([...brollTags(asset), ...tokens(asset.name)]);
    let score = 0;
    let matched = '';
    for (const t of qTokens) {
      if (assetTokens.has(t)) {
        score += 4;
        matched = matched ? `${matched},${t}` : t;
      }
    }
    for (const t of ctxTokens) {
      if (assetTokens.has(t)) score += 1;
    }
    if (query && asset.name.toLowerCase().includes(query.toLowerCase().trim().slice(0, 24))) score += 2;
    if (asset.kind === 'video') {
      score += (asset.duration ?? 0) >= windowDuration + 0.2 ? 2 : -3;
    } else if (score > 0) {
      score += 1; // images have no duration limit, bonus only when already relevant
    }
    if (asset.license) score += 0.5;
    if (score > 0) scored.push({ asset, score: Math.round(score * 10) / 10, reason: matched ? `matches: ${matched}` : 'weak context match' });
  }
  return scored.sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
}

export interface ResolvedBroll {
  index: number;
  asset: BrollRow;
  start: number;
  end: number;
  mode: BrollPlacement['mode'];
  position: BrollPlacement['position'];
  sizePercent: number;
}

export interface BrollResolution {
  specs: ResolvedBroll[];
  dropped: string[];
  warnings: string[];
}

/**
 * Resolve EDL b-roll placements to concrete local files. Explicit asset ids win,
 * then query-based search against the registry; placements that cannot be
 * resolved stay dropped (reported), never invented.
 */
export function resolveBrollPlacements(
  placements: BrollPlacement[],
  contextText: string
): BrollResolution {
  const library = listBroll(true);
  const specs: ResolvedBroll[] = [];
  const dropped: string[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const windowDur = p.end - p.start;
    let asset = p.assetId ? library.find((b) => b.id === p.assetId) : undefined;
    if (p.assetId && !asset) {
      warnings.push(`b-roll asset "${p.assetId}" not found, trying query`);
      asset = undefined;
    }
    if (!asset && p.query) {
      const best = scoreBrollAssets(p.query, contextText, library, windowDur)[0];
      if (best) asset = best.asset;
      else dropped.push(`broll:${i} (no asset matches "${p.query.slice(0, 60)}")`);
    }
    if (!asset && !p.query && p.assetId) dropped.push(`broll:${i} (asset ${p.assetId} missing)`);
    if (!asset) continue;
    let start = p.start;
    let end = p.end;
    if (asset.kind === 'video' && (asset.duration ?? 0) > 0 && end - start > (asset.duration ?? 0) - 0.1) {
      end = start + Math.max(0.8, (asset.duration ?? 0) - 0.1);
    }
    if (end <= start + 0.2) {
      dropped.push(`broll:${i} (window collapses inside asset "${asset.name}")`);
      continue;
    }
    specs.push({
      index: i,
      asset,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      mode: p.mode,
      position: p.position,
      sizePercent: p.sizePercent,
    });
  }
  return { specs, dropped, warnings };
}
