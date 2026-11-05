import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { q, J } from '../lib/sqlite.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { probeVideo, runCmd, type MediaProbe } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { safeExtension } from './assets.js';

/**
 * Permanent Reference Library.
 *
 * Uploaded reference videos are copied into storage/references/<id>/ and kept
 * until explicitly deleted. SQLite stores metadata only; API responses never
 * expose filesystem paths (see referenceView).
 */

export const REFERENCE_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

export type ReferenceStatus = 'downloading' | 'uploaded' | 'analyzing' | 'analyzed' | 'partial' | 'failed';

export interface ReferenceRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string | null;
  source_path: string;
  thumbnail_path: string | null;
  mime: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  size_bytes: number | null;
  status: ReferenceStatus;
  analysis_version: number;
  error: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ReferenceAnalysisRow {
  id: number;
  reference_id: string;
  profile_version: number;
  analysis_version: number;
  status: 'complete' | 'partial';
  profile: string | null;
  measurements: string | null;
  evidence: string | null;
  model: string | null;
  prompt_meta: string | null;
  error: string | null;
  created_at: string;
}

export interface ReferenceView {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  sizeBytes: number | null;
  mime: string | null;
  status: ReferenceStatus;
  analysisVersion: number;
  error: string | null;
  enabled: boolean;
  hasThumbnail: boolean;
  thumbnailUrl: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export function referenceDir(id: string): string {
  const dir = path.join(config.dirs.references, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function referenceFramesDir(id: string): string {
  const dir = path.join(referenceDir(id), 'frames');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function referenceView(row: ReferenceRow): ReferenceView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: J.read<string[]>(row.tags) ?? [],
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    sizeBytes: row.size_bytes,
    mime: row.mime,
    status: row.status,
    analysisVersion: row.analysis_version,
    error: row.error,
    enabled: !!row.enabled,
    hasThumbnail: !!(row.thumbnail_path && fs.existsSync(row.thumbnail_path)),
    thumbnailUrl: `/api/references/${row.id}/thumbnail`,
    sourceUrl: `/api/references/${row.id}/source`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listReferences(opts: { category?: string; status?: string; search?: string; enabledOnly?: boolean; limit?: number; offset?: number } = {}): { references: ReferenceRow[]; total: number } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.category) {
    where.push('category = ?');
    args.push(opts.category);
  }
  if (opts.status) {
    where.push('status = ?');
    args.push(opts.status);
  }
  if (opts.enabledOnly) where.push('enabled = 1');
  if (opts.search) {
    where.push('(LOWER(name) LIKE ? OR LOWER(COALESCE(description, \'\')) LIKE ? OR LOWER(COALESCE(tags, \'\')) LIKE ?)');
    const like = `%${opts.search.toLowerCase()}%`;
    args.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reference_library ${clause}`, ...args)?.n ?? 0;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = q.all<ReferenceRow>(
    `SELECT * FROM reference_library ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    offset
  );
  return { references: rows, total };
}

export function getReference(id: string): ReferenceRow | undefined {
  return q.get<ReferenceRow>('SELECT * FROM reference_library WHERE id = ?', id);
}

export function getLatestAnalysis(id: string): ReferenceAnalysisRow | undefined {
  return q.get<ReferenceAnalysisRow>('SELECT * FROM reference_analyses WHERE reference_id = ? ORDER BY analysis_version DESC LIMIT 1', id);
}

export function getAnalysisForVersion(id: string, analysisVersion: number): ReferenceAnalysisRow | undefined {
  return q.get<ReferenceAnalysisRow>('SELECT * FROM reference_analyses WHERE reference_id = ? AND analysis_version = ?', id, analysisVersion);
}

export function referenceUsageStats(id: string): { uses: number; good: number; bad: number } {
  const row = q.get<{ uses: number; good: number; bad: number }>(
    `SELECT COUNT(*) AS uses,
            SUM(CASE WHEN outcome = 'good' THEN 1 ELSE 0 END) AS good,
            SUM(CASE WHEN outcome = 'bad' THEN 1 ELSE 0 END) AS bad
     FROM reference_usage WHERE reference_id = ?`,
    id
  );
  return { uses: row?.uses ?? 0, good: row?.good ?? 0, bad: row?.bad ?? 0 };
}

const REFERENCE_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
};

const THUMB_WIDTH = 320;

/** Extract a representative thumbnail (25% into the video, scaled down). */
export async function generateThumbnail(sourcePath: string, id: string, duration: number | null): Promise<string | null> {
  const dir = referenceDir(id);
  const out = path.join(dir, 'thumbnail.jpg');
  const at = duration && duration > 2 ? Math.min(duration * 0.25, duration - 0.5) : 0;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', at.toFixed(3),
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', `scale=${THUMB_WIDTH}:-2`,
    out,
  ];
  const { code, stderr } = await runCmd(config.ffmpeg, args);
  if (code !== 0 || !fs.existsSync(out)) {
    logger.warn('VIDEO', `reference thumbnail failed (${code}): ${stderr.slice(-160)}`);
    return null;
  }
  return out;
}

export interface CreateReferenceInput {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
}

/**
 * Validate + persist an uploaded reference. The temp upload is moved into the
 * permanent library directory; the file is only trusted after FFprobe confirms
 * a real video stream, size and duration limits.
 */
export async function createReference(tmpPath: string, originalName: string, input: CreateReferenceInput = {}): Promise<ReferenceRow> {
  const settings = getSettings('learning');
  const ext = safeExtension(originalName, REFERENCE_EXTS);
  const stat = fs.statSync(tmpPath);
  if (stat.size <= 0) throw new Error('uploaded file is empty');
  if (stat.size > settings.max_reference_bytes) {
    throw new Error(`reference too large (max ${Math.round(settings.max_reference_bytes / 1e6)}MB)`);
  }

  let probe: MediaProbe;
  try {
    probe = await probeVideo(tmpPath);
  } catch (e) {
    throw new Error(`FFprobe could not read the file: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!probe.hasVideo) throw new Error('file has no video stream');
  if (probe.duration <= 0.5) throw new Error('file is too short to analyse');
  if (probe.duration > settings.max_reference_duration) {
    throw new Error(`reference too long (max ${Math.round(settings.max_reference_duration / 60)} minutes)`);
  }

  const id = nanoid(10);
  const dir = referenceDir(id);
  const extSafe = ext; // already allow-listed; never derived from raw input beyond that
  const sourcePath = path.join(dir, `source${extSafe}`);
  fs.copyFileSync(tmpPath, sourcePath);
  try { fs.rmSync(tmpPath, { force: true }); } catch { /* temp already moved */ }

  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : [];
  const thumbnailPath = await generateThumbnail(sourcePath, id, probe.duration);
  const name = (input.name?.trim() || path.parse(originalName).name).slice(0, 120) || `reference-${id}`;

  q.run(
    `INSERT INTO reference_library
       (id, name, description, category, tags, source_path, thumbnail_path, mime, duration, width, height, fps, size_bytes, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    name,
    input.description?.trim().slice(0, 600) || null,
    input.category?.trim().toLowerCase().slice(0, 40) || null,
    tags.length ? JSON.stringify(tags) : null,
    sourcePath,
    thumbnailPath,
    REFERENCE_MIME[extSafe] ?? 'video/mp4',
    probe.duration,
    probe.width,
    probe.height,
    probe.fps,
    stat.size,
    'uploaded'
  );

  writeReferenceMeta(id);
  logger.info('VIDEO', `reference uploaded: ${id} "${name}" (${probe.duration.toFixed(1)}s ${probe.width}x${probe.height})`);
  return getReference(id)!;
}

export interface DownloadReferenceInput extends CreateReferenceInput {
  url: string;
}

/**
 * Create a placeholder row for a link import (YouTube/TikTok/Instagram/...).
 * The `reference_download` job fills in the real file, probe data and
 * thumbnail via finalizeDownloadedReference — or marks the row failed.
 */
export function createDownloadingReference(input: DownloadReferenceInput): ReferenceRow {
  const id = nanoid(10);
  const dir = referenceDir(id);
  const sourcePath = path.join(dir, 'source.mp4');
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : [];
  let fallback = 'reference';
  try {
    const u = new URL(input.url);
    fallback = decodeURIComponent(`${u.hostname}${u.pathname}`).replace(/[/?&=]+/g, ' ').trim().slice(0, 80) || u.hostname;
  } catch { /* caller validated; keep the generic name */ }
  const name = (input.name?.trim() || fallback).slice(0, 120) || `reference-${id}`;
  q.run(
    `INSERT INTO reference_library
       (id, name, description, category, tags, source_path, status)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    name,
    input.description?.trim().slice(0, 600) || null,
    input.category?.trim().toLowerCase().slice(0, 40) || null,
    tags.length ? JSON.stringify(tags) : null,
    sourcePath,
    'downloading'
  );
  writeReferenceMeta(id);
  logger.info('VIDEO', `reference download queued: ${id} "${name}"`);
  return getReference(id)!;
}

/**
 * Validate the downloaded file (size/duration/video stream), move it into the
 * canonical `source.<ext>` name, probe it and mark the row uploaded.
 * Throws after marking the row failed when the file is unusable.
 */
export async function finalizeDownloadedReference(id: string, downloadedPath: string): Promise<ReferenceRow> {
  const row = getReference(id);
  if (!row) throw new Error(`reference ${id} not found`);
  const settings = getSettings('learning');
  const ext = safeExtension(downloadedPath, REFERENCE_EXTS);
  const fail = (msg: string): never => {
    try { fs.rmSync(downloadedPath, { force: true }); } catch { /* nothing to clean */ }
    setReferenceStatus(id, 'failed', msg);
    writeReferenceMeta(id);
    throw new Error(msg);
  };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(downloadedPath);
  } catch {
    return fail('downloaded file is missing');
  }
  if (stat.size <= 0) return fail('downloaded file is empty');
  if (stat.size > settings.max_reference_bytes) {
    return fail(`reference too large (max ${Math.round(settings.max_reference_bytes / 1e6)}MB)`);
  }
  let probe: MediaProbe;
  try {
    probe = await probeVideo(downloadedPath);
  } catch (e) {
    return fail(`FFprobe could not read the file: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!probe.hasVideo) return fail('downloaded file has no video stream');
  if (probe.duration <= 0.5) return fail('video is too short to analyse');
  if (probe.duration > settings.max_reference_duration) {
    return fail(`reference too long (max ${Math.round(settings.max_reference_duration / 60)} minutes)`);
  }

  const dir = referenceDir(id);
  const sourcePath = path.join(dir, `source${ext}`);
  if (downloadedPath !== sourcePath) fs.renameSync(downloadedPath, sourcePath);
  const thumbnailPath = await generateThumbnail(sourcePath, id, probe.duration);
  q.run(
    `UPDATE reference_library
     SET source_path = ?, thumbnail_path = ?, mime = ?, duration = ?, width = ?, height = ?, fps = ?, size_bytes = ?,
         status = 'uploaded', error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
    sourcePath,
    thumbnailPath,
    REFERENCE_MIME[ext] ?? 'video/mp4',
    probe.duration,
    probe.width,
    probe.height,
    probe.fps,
    stat.size,
    id
  );
  writeReferenceMeta(id);
  logger.info('VIDEO', `reference downloaded: ${id} (${probe.duration.toFixed(1)}s ${probe.width}x${probe.height})`);
  return getReference(id)!;
}

export function updateReference(
  id: string,
  patch: { name?: string; description?: string | null; category?: string | null; tags?: string[]; enabled?: boolean }
): ReferenceRow | undefined {
  const row = getReference(id);
  if (!row) return undefined;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.name === 'string') {
    const name = patch.name.trim().slice(0, 120);
    if (name) {
      sets.push('name = ?');
      args.push(name);
    }
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    args.push(typeof patch.description === 'string' ? patch.description.trim().slice(0, 600) || null : null);
  }
  if (patch.category !== undefined) {
    sets.push('category = ?');
    args.push(typeof patch.category === 'string' ? patch.category.trim().toLowerCase().slice(0, 40) || null : null);
  }
  if (patch.tags !== undefined) {
    const tags = Array.isArray(patch.tags) ? patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : [];
    sets.push('tags = ?');
    args.push(tags.length ? JSON.stringify(tags) : null);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  if (!sets.length) return row;
  q.run(`UPDATE reference_library SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...args, id);
  writeReferenceMeta(id);
  return getReference(id);
}

/** Deletes the DB row and every file the reference owns. */
export function deleteReference(id: string): boolean {
  const row = getReference(id);
  if (!row) return false;
  q.run('DELETE FROM reference_library WHERE id = ?', id); // analyses/usage cascade
  const dir = path.join(config.dirs.references, id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.warn('SYSTEM', `could not remove reference directory: ${(e as Error).message}`);
  }
  logger.info('SYSTEM', `reference deleted: ${id}`);
  return true;
}

export function setReferenceStatus(id: string, status: ReferenceStatus, error: string | null = null): void {
  q.run("UPDATE reference_library SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?", status, error, id);
}

export function setReferenceAnalysisVersion(id: string, version: number): void {
  q.run("UPDATE reference_library SET analysis_version = ?, updated_at = datetime('now') WHERE id = ?", version, id);
}

/** Persist reference metadata.json into the library folder (human-inspectable copy). */
export function writeReferenceMeta(id: string): void {
  const row = getReference(id);
  if (!row) return;
  const meta = {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: J.read<string[]>(row.tags) ?? [],
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    sizeBytes: row.size_bytes,
    status: row.status,
    analysisVersion: row.analysis_version,
    updatedAt: row.updated_at,
  };
  try {
    fs.writeFileSync(path.join(referenceDir(id), 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    logger.warn('SYSTEM', `could not write reference metadata.json: ${(e as Error).message}`);
  }
}

/** Remove extracted frames (used before re-analysis). */
export function clearReferenceFrames(id: string): void {
  const dir = path.join(referenceDir(id), 'frames');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* nothing to clean */ }
}

export function listCategories(): { category: string; count: number }[] {
  return q.all<{ category: string; count: number }>(
    "SELECT category, COUNT(*) AS count FROM reference_library WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY count DESC"
  );
}
