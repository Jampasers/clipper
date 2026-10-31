import { Router } from 'express';
import { requireAuth } from '../lib/middleware.js';
import {
  listRenderPresets, saveRenderPreset, deleteRenderPreset, defaultRenderOptions,
  resolveRenderOptions, getRenderSnapshots, SUBTITLE_STYLES, WATERMARK_POSITIONS,
} from '../services/render-options.js';
import { getClip } from '../services/clips.js';
import { listEditingPlans } from '../services/editing-plan.js';
import { listWatermarks, listMusic } from '../services/assets.js';
import { MUSIC_MOODS } from '../services/music.js';

export const renderRouter = Router();
renderRouter.use(requireAuth);

renderRouter.get('/options', (_req, res) => {
  res.json({
    defaults: defaultRenderOptions(),
    presets: listRenderPresets(),
    subtitleStyles: SUBTITLE_STYLES,
    watermarkPositions: WATERMARK_POSITIONS,
    musicMoods: MUSIC_MOODS,
    watermarks: listWatermarks(true),
    music: listMusic(true),
  });
});

renderRouter.get('/presets', (_req, res) => {
  res.json({ presets: listRenderPresets() });
});

renderRouter.post('/presets', (req, res, next) => {
  try {
    res.status(201).json({ preset: saveRenderPreset(String(req.body?.name ?? ''), req.body?.options) });
  } catch (e) {
    next(e);
  }
});

renderRouter.delete('/presets/:name', (req, res) => {
  if (!deleteRenderPreset(String(req.params.name))) return res.status(404).json({ error: 'preset not found or built-in' });
  res.json({ ok: true });
});

/** Validate a would-be render request without enqueuing anything. */
renderRouter.post('/validate', (req, res, next) => {
  try {
    res.json(resolveRenderOptions(req.body?.options ?? null, req.body?.preset ?? null));
  } catch (e) {
    next(e);
  }
});

renderRouter.get('/clips/:id/plans', (req, res) => {
  const clip = getClip(String(req.params.id));
  if (!clip) return res.status(404).json({ error: 'clip not found' });
  res.json({ plans: listEditingPlans(clip.id, 10), snapshots: getRenderSnapshots(clip.id, 10) });
});
