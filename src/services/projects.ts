import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { q, J } from '../lib/sqlite.js';
import { config } from '../config.js';
import { probeVideo, type MediaProbe } from '../lib/ffmpeg.js';
import { enqueue } from '../lib/queue.js';
import { logger } from '../lib/log.js';

export type ProjectStatus =
  | 'DOWNLOADING' | 'UPLOADED' | 'TRANSCRIBING' | 'ANALYZING' | 'FINDING_CLIPS' | 'SCORING'
  | 'READY' | 'RENDERING' | 'COMPLETED' | 'FAILED';

export interface ProjectRow {
  id: string;
  name: string;
  source_path: string;
  status: ProjectStatus;
  meta: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function projectDir(id: string): string {
  const d = path.join(config.dirs.project, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function createProject(name: string, sourcePath: string): ProjectRow {
  const id = nanoid(10);
  const dir = projectDir(id);
  const ext = path.extname(sourcePath) || '.mp4';
  const finalSource = path.join(dir, `source${ext}`);
  fs.renameSync(sourcePath, finalSource);
  return insertProject(id, name, finalSource);
}

/** Create a project placeholder that a queued download job will fill in. */
export function createDownloadingProject(id: string, name: string, sourcePath: string): ProjectRow {
  return insertProject(id, name, sourcePath, 'DOWNLOADING');
}

function insertProject(id: string, name: string, finalSource: string, status: ProjectStatus = 'UPLOADED'): ProjectRow {
  q.run(
    'INSERT INTO projects (id, name, source_path, status) VALUES (?,?,?,?)',
    id, name, finalSource, status
  );
  logger.info('VIDEO', `project ${id} created: ${name}`);
  return getProject(id)!;
}

export function getProject(id: string): ProjectRow | undefined {
  return q.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
}

export function listProjects(limit = 100): ProjectRow[] {
  return q.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC LIMIT ?', limit);
}

export function setProjectStatus(id: string, status: ProjectStatus, error: string | null = null) {
  q.run("UPDATE projects SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?", status, error, id);
}

export function setProjectMeta(id: string, meta: MediaProbe) {
  q.run("UPDATE projects SET meta = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(meta), id);
}

export function getProjectMeta(p: ProjectRow): MediaProbe | undefined {
  return J.read<MediaProbe>(p.meta);
}

export function deleteProject(id: string) {
  const p = getProject(id);
  if (!p) return;
  try {
    fs.rmSync(projectDir(id), { recursive: true, force: true });
  } catch (e) {
    logger.warn('VIDEO', `could not remove project dir ${id}: ${(e as Error).message}`);
  }
  q.run('DELETE FROM projects WHERE id = ?', id);
}

/** Run FFprobe and cache the result (independent of the queue so it is instant). */
export async function probeProject(id: string): Promise<MediaProbe> {
  const p = getProject(id);
  if (!p) throw new Error(`Project ${id} not found`);
  const meta = await probeVideo(p.source_path);
  setProjectMeta(id, meta);
  return meta;
}

export function ensureProbe(id: string): Promise<MediaProbe> {
  const p = getProject(id);
  if (!p) return Promise.reject(new Error('project not found'));
  const cached = getProjectMeta(p);
  if (cached && cached.duration > 0) return Promise.resolve(cached);
  return probeProject(id);
}

export function enqueuePipeline(projectId: string): string {
  setProjectStatus(projectId, 'TRANSCRIBING');
  return enqueue('transcription', { project_id: projectId });
}

export function projectSummary(id: string) {
  const p = getProject(id);
  if (!p) return null;
  const jobs = q.all('SELECT id, type, status, progress, error, created_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC', id);
  const clips = q.all('SELECT id, ord, start, end, title, overall, status, aspect, subtitle_preset FROM clips WHERE project_id = ? ORDER BY ord ASC', id);
  const transcript = q.get<{ language: string; model: string; duration: number | null }>(
    'SELECT language, model, duration FROM transcripts WHERE project_id = ? ORDER BY id DESC LIMIT 1', id
  );
  const activeJobs = jobs.filter((j: any) => j.status === 'queued' || j.status === 'running');
  return {
    ...p,
    meta: J.read<MediaProbe>(p.meta),
    jobs,
    activeJobs,
    nextJob: activeJobs.find((j: any) => j.status === 'running') ?? activeJobs[0] ?? null,
    clips: clips.map((c: any) => ({ ...c })),
    transcript,
    files: listProjectFiles(id),
  };
}

export function listProjectFiles(id: string): { name: string; size: number; kind: string }[] {
  const dir = projectDir(id);
  const out: { name: string; size: number; kind: string }[] = [];
  const walk = (d: string, prefix = '') => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out.push({ name: rel, size: fs.statSync(full).size, kind: guessKind(entry.name) });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function guessKind(name: string): string {
  if (/\.(mp4|mov|mkv|webm|avi)$/i.test(name)) return 'video';
  if (/\.(wav|mp3|m4a|aac)$/i.test(name)) return 'audio';
  if (/\.(json|txt)$/i.test(name)) return 'data';
  if (/\.(srt|ass|vtt)$/i.test(name)) return 'subtitle';
  return 'file';
}
