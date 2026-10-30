import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { q } from '../lib/sqlite.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/middleware.js';
import { enqueue, listJobs, retryJob, cancelJob } from '../lib/queue.js';
import { enqueueProjectPipeline } from '../services/pipeline.js';
import {
  createProject, createDownloadingProject, getProject, listProjects, deleteProject, probeProject,
  projectSummary, ensureProbe, setProjectStatus, projectDir,
} from '../services/projects.js';
import { loadTranscript } from '../services/transcribe.js';
import { clipView, selectClips, listClips } from '../services/clips.js';
import { ytdlpMeta } from '../lib/ytdlp.js';
import { logger } from '../lib/log.js';
import { nanoid } from 'nanoid';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const ALLOWED_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);

const upload = multer({
  storage: multer.diskStorage({
    destination: config.dirs.input,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp4';
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) return cb(new Error(`Unsupported file type ${ext}. Allowed: ${[...ALLOWED_EXTS].join(', ')}`));
    cb(null, true);
  },
});

projectsRouter.post('/', upload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no video file uploaded (field: "video")' });
    const name = (req.body?.name as string) || path.parse(req.file.originalname).name;
    const project = createProject(name, req.file.path);
    let meta;
    try {
      meta = await probeProject(project.id);
    } catch (e: any) {
      deleteProject(project.id);
      fs.rmSync(req.file.path, { force: true });
      throw new Error(`FFprobe could not read the file: ${String(e.message).slice(0, 200)}`);
    }
    if (!meta.hasVideo) {
      deleteProject(project.id);
      return res.status(400).json({ error: 'File has no video stream' });
    }
    enqueueProjectPipeline(project.id);
    logger.info('VIDEO', `upload accepted: ${project.id} (${meta.duration.toFixed(1)}s ${meta.width}x${meta.height})`);
    res.status(201).json({ project: projectSummary(project.id) });
  } catch (e) {
    next(e);
  }
});

projectsRouter.post('/url', async (req, res, next) => {
  try {
    const raw = String((req.body ?? {}).url ?? '').trim();
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'invalid URL' }); }
    if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'only http(s) URLs are supported' });

    const yt = await ytdlpMeta(parsed.href).catch((e) => {
      throw new Error(`Could not read that video: ${(e as Error).message}`);
    });
    const id = nanoid(10);
    const name = (req.body?.name as string) || yt.title || parsed.hostname + parsed.pathname;
    createDownloadingProject(id, name, path.join(projectDir(id), 'source.mp4'));
    enqueue('download', { project_id: id, payload: { url: parsed.href } });
    logger.info('VIDEO', `downloading "${name}" -> ${id}`);
    res.status(201).json({ project: projectSummary(id) });
  } catch (e) {
    next(e);
  }
});

projectsRouter.post('/:id/run', async (req, res) => {
  const id = String(req.params.id);
  const p = getProject(id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const from = (req.body?.from as string) || 'transcription';
  const statusMap: Record<string, string> = {
    transcription: 'TRANSCRIBING',
    analysis: 'ANALYZING',
    candidates: 'FINDING_CLIPS',
    scoring: 'SCORING',
  };
  const status = statusMap[from];
  if (!status) return res.status(400).json({ error: `unknown stage ${from}` });
  setProjectStatus(id, status as any, null);
  const typeMap: Record<string, any> = { transcription: 'transcription', analysis: 'analysis', candidates: 'candidate_generation', scoring: 'scoring' };
  const jobId = enqueue(typeMap[from], { project_id: id });
  res.json({ ok: true, job: jobId });
});

projectsRouter.post('/:id/select', async (req, res) => {
  const id = String(req.params.id);
  if (!getProject(id)) return res.status(404).json({ error: 'project not found' });
  const { top, ids } = (req.body ?? {}) as { top?: number; ids?: string[] };
  if (!top && !(ids?.length)) return res.status(400).json({ error: 'provide top (number) or ids (array)' });
  const chosen = selectClips(id, { top, ids });
  res.json({ ok: true, selected: chosen.map(clipView) });
});

projectsRouter.get('/', (_req, res) => {
  res.json({
    projects: listProjects(200).map((p) => ({
      ...p,
      meta: p.meta ? JSON.parse(p.meta) : null,
      job: p.status === 'DOWNLOADING'
        ? q.get("SELECT id, status, progress, error FROM jobs WHERE project_id = ? AND type = 'download' ORDER BY created_at DESC LIMIT 1", p.id)
        : null,
    })),
  });
});

projectsRouter.get('/:id', async (req, res) => {
  const id = String(req.params.id);
  const summary = projectSummary(id);
  if (!summary) return res.status(404).json({ error: 'project not found' });
  res.json({
    project: summary,
    clips: summary.clips.map(clipView),
    transcript: loadTranscript(id) ? { language: loadTranscript(id)!.language, segmentCount: loadTranscript(id)!.segments.length } : null,
    transcriptFull: loadTranscript(id),
  });
});

projectsRouter.delete('/:id', async (req, res) => {
  const id = String(req.params.id);
  deleteProject(id);
  res.json({ ok: true });
});

projectsRouter.get('/:id/transcript', (_req, res) => {
  const t = loadTranscript(String(_req.params.id));
  if (!t) return res.status(404).json({ error: 'no transcript yet' });
  res.json(t);
});

/** Stream the original source video for the project page player. */
projectsRouter.get('/:id/source', (req, res) => {
  const p = getProject(String(req.params.id));
  if (!p || !fs.existsSync(p.source_path)) return res.status(404).json({ error: 'source not found' });
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(p.source_path);
});

/** Media streaming for previews/finals (authenticated). */
export const mediaRouter = Router();
mediaRouter.use(requireAuth);
mediaRouter.get('/:scope/:file', (req, res) => {
  const scope = req.params.scope as string;
  const file = req.params.file as string;
  const scopeMap: Record<string, string> = { previews: config.dirs.preview, outputs: config.dirs.output };
  const dir = scopeMap[scope];
  if (!dir) return res.status(404).end();
  const safe = path.basename(file);
  const full = path.join(dir, safe);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'file not found' });
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(full);
});

export const jobsRouter = Router();
jobsRouter.use(requireAuth);
jobsRouter.get('/', (_req, res) => {
  res.json({ jobs: listJobs(100) });
});
jobsRouter.post('/:id/retry', (req, res) => {
  const ok = retryJob(String(req.params.id));
  res.json({ ok });
});
jobsRouter.post('/:id/cancel', (req, res) => {
  const ok = cancelJob(String(req.params.id));
  res.json({ ok });
});

export { ensureProbe };
