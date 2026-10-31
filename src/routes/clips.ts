import { Router } from 'express';
import { requireAuth } from '../lib/middleware.js';
import { q } from '../lib/sqlite.js';
import { getClip, updateClip, listClips, clipView, rejectClip } from '../services/clips.js';
import { enqueueRender } from '../services/pipeline.js';
import { aiEditClip } from '../services/clip-edit.js';
import { getProject, ensureProbe } from '../services/projects.js';
import { getSettings } from '../lib/settings.js';

export const clipsApi = Router();
clipsApi.use(requireAuth);

clipsApi.get('/', (req, res) => {
  const projectId = req.query.project_id as string | undefined;
  const status = req.query.status as string | undefined;
  res.json({ clips: listClips({ projectId, status }).map(clipView) });
});

clipsApi.get('/:id', (req, res) => {
  const clip = getClip(String(req.params.id));
  if (!clip) return res.status(404).json({ error: 'clip not found' });
  const project = getProject(clip.project_id);
  const job = q.get<{ id: string; type: string; status: string; progress: number; error: string | null }>(
    "SELECT id, type, status, progress, error FROM jobs WHERE clip_id = ? AND type IN ('render_preview','render_final') ORDER BY created_at DESC LIMIT 1",
    clip.id
  );
  res.json({ clip: clipView(clip), project, job: job ?? null });
});

/** Manual boundary/title/style edit. times are clamped by the source duration. */
clipsApi.patch('/:id', async (req, res, next) => {
  try {
    const clip = getClip(String(req.params.id));
    if (!clip) return res.status(404).json({ error: 'clip not found' });
    const project = getProject(clip.project_id)!;
    const meta = project.meta ? JSON.parse(project.meta) : await ensureProbe(clip.project_id);
    const duration = meta.duration ?? Infinity;
    const patch: Record<string, unknown> = {};
    const startFromBody = typeof req.body?.start === 'number' ? Math.max(0, Math.min(duration - 5, req.body.start)) : null;
    if (startFromBody !== null) patch.start = startFromBody;
    if (typeof req.body?.end === 'number') patch.end = Math.min(duration, Math.max((startFromBody ?? clip.start) + 5, req.body.end));
    if (typeof req.body?.title === 'string') patch.title = req.body.title.slice(0, 120);
    if (typeof req.body?.hook === 'string') patch.hook = req.body.hook.slice(0, 300);
    if (typeof req.body?.aspect === 'string' && ['9:16', '1:1', '16:9'].includes(req.body.aspect)) patch.aspect = req.body.aspect;
    if (typeof req.body?.subtitle_preset === 'string') {
      const st = getSettings('subtitles');
      if (!st.presets[req.body.subtitle_preset]) return res.status(400).json({ error: 'unknown subtitle preset' });
      patch.subtitle_preset = req.body.subtitle_preset;
    }
    const updated = updateClip(clip.id, patch);
    res.json({ clip: clipView(updated!) });
  } catch (e) {
    next(e);
  }
});

clipsApi.post('/:id/preview', (req, res, next) => {
  try {
    const clip = getClip(String(req.params.id));
    if (!clip) return res.status(404).json({ error: 'clip not found' });
    const job = enqueueRender(clip.id, 'preview', {
      options: req.body?.options ?? undefined,
      preset: typeof req.body?.preset === 'string' ? req.body.preset : null,
    });
    res.status(202).json({ ok: true, job });
  } catch (e) { next(e); }
});

clipsApi.post('/:id/render', (req, res, next) => {
  try {
    const clip = getClip(String(req.params.id));
    if (!clip) return res.status(404).json({ error: 'clip not found' });
    const kind = (req.body?.kind as string) === 'telegram' ? 'telegram' : 'final';
    const job = enqueueRender(clip.id, kind as 'final' | 'telegram', {
      options: req.body?.options ?? undefined,
      preset: typeof req.body?.preset === 'string' ? req.body.preset : null,
    });
    res.status(202).json({ ok: true, job });
  } catch (e) { next(e); }
});

clipsApi.post('/:id/reject', (req, res) => {
  const updated = rejectClip(String(req.params.id));
  if (!updated) return res.status(404).json({ error: 'clip not found' });
  res.json({ clip: clipView(updated) });
});

clipsApi.post('/:id/ai-edit', async (req, res, next) => {
  try {
    const instruction = String(req.body?.instruction ?? '').trim();
    if (!instruction) return res.status(400).json({ error: 'instruction required' });
    const outcome = await aiEditClip(String(req.params.id), instruction);
    res.status(outcome.ok ? 200 : 422).json(outcome);
  } catch (e) { next(e); }
});
