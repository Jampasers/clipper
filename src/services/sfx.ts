import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { q } from '../lib/sqlite.js';
import { config } from '../config.js';
import { probeVideo } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import { safeExtension } from './assets.js';
import type { SfxPlacement } from './edl.js';

/**
 * Sound-effect library: user-provided audio files placed at output-timeline
 * positions by the EDL. Same trust model as the music library — local files
 * only, license/source metadata kept. Missing assets are dropped, never
 * substituted with random content.
 */

export const SFX_DIR = 'sfx';
export const SFX_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus']);
export const SFX_MAX_BYTES = 20 * 1024 * 1024;

export interface SfxRow {
  id: string;
  name: string;
  file_path: string;
  mime: string;
  duration: number | null;
  tags: string | null;
  source: string | null;
  license: string | null;
  attribution: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export function sfxDir(): string {
  const d = path.join(config.dirs.assets, SFX_DIR);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function listSfx(enabledOnly = false): SfxRow[] {
  return q.all<SfxRow>(`SELECT * FROM sound_effects ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY name ASC`);
}

export function getSfx(id: string): SfxRow | undefined {
  return q.get<SfxRow>('SELECT * FROM sound_effects WHERE id = ?', id);
}

export async function createSfx(
  tmpPath: string,
  originalName: string,
  meta: Partial<Pick<SfxRow, 'name' | 'tags' | 'source' | 'license' | 'attribution'>> = {}
): Promise<SfxRow> {
  const ext = safeExtension(originalName, SFX_EXTS);
  const stat = fs.statSync(tmpPath);
  if (stat.size <= 0) throw new Error('uploaded file is empty');
  if (stat.size > SFX_MAX_BYTES) throw new Error(`file too large (max ${Math.round(SFX_MAX_BYTES / 1e6)}MB)`);

  const id = nanoid(10);
  const filePath = path.join(sfxDir(), `${id}${ext}`);
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
    `INSERT INTO sound_effects (id, name, file_path, mime, duration, tags, source, license, attribution, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    String(meta.name ?? path.parse(originalName).name).slice(0, 80) || `sfx-${id}`,
    filePath,
    probe.acodec === 'mp3' ? 'audio/mpeg' : `audio/${ext.slice(1)}`,
    Math.round((probe.duration ?? 0) * 100) / 100,
    String(meta.tags ?? '').slice(0, 300) || null,
    String(meta.source ?? 'upload').slice(0, 120),
    meta.license ? String(meta.license).slice(0, 200) : null,
    meta.attribution ? String(meta.attribution).slice(0, 300) : null,
    1
  );
  logger.info('SYSTEM', `sfx created: ${id} "${meta.name ?? originalName}" (${probe.duration?.toFixed(2)}s)`);
  return getSfx(id)!;
}

export function updateSfx(id: string, patch: Partial<SfxRow>): SfxRow | undefined {
  const allowed: Partial<Record<keyof SfxRow, unknown>> = {};
  if (typeof patch.name === 'string') allowed.name = patch.name.slice(0, 80);
  if (typeof patch.tags === 'string' || patch.tags === null) allowed.tags = patch.tags;
  if (typeof patch.source === 'string' || patch.source === null) allowed.source = patch.source;
  if (typeof patch.license === 'string' || patch.license === null) allowed.license = patch.license;
  if (typeof patch.attribution === 'string' || patch.attribution === null) allowed.attribution = patch.attribution;
  if (patch.enabled !== undefined) allowed.enabled = patch.enabled ? 1 : 0;
  const sets = Object.keys(allowed);
  if (!sets.length) return getSfx(id);
  q.run(
    `UPDATE sound_effects SET ${sets.map((s) => `${s} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...sets.map((s) => allowed[s as keyof SfxRow]),
    id
  );
  return getSfx(id);
}

export function deleteSfx(id: string): boolean {
  const s = getSfx(id);
  if (!s) return false;
  if (fs.existsSync(s.file_path)) {
    try { fs.rmSync(s.file_path, { force: true }); } catch (e) { logger.warn('SYSTEM', `could not remove sfx file: ${(e as Error).message}`); }
  }
  q.run('DELETE FROM sound_effects WHERE id = ?', id);
  return true;
}

export interface ResolvedSfx {
  asset: SfxRow;
  at: number;
  volumeDb: number;
}

/** Resolve EDL sfx placements to playable files; missing assets are dropped. */
export function resolveSfxPlacements(placements: SfxPlacement[]): { specs: ResolvedSfx[]; dropped: string[] } {
  const specs: ResolvedSfx[] = [];
  const dropped: string[] = [];
  for (const [i, p] of placements.entries()) {
    const asset = getSfx(p.libraryId);
    if (!asset || !asset.enabled || !fs.existsSync(asset.file_path)) {
      dropped.push(`sfx:${i} (asset ${p.libraryId} unavailable)`);
      continue;
    }
    specs.push({ asset, at: Math.round(p.at * 1000) / 1000, volumeDb: p.volumeDb });
  }
  return { specs, dropped };
}
