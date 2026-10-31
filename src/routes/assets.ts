import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { config } from '../config.js';
import { requireAuth } from '../lib/middleware.js';
import {
  listWatermarks, getWatermark, createWatermark, updateWatermark, deleteWatermark,
  listMusic, getMusic, createMusic, updateMusic, deleteMusic,
  WATERMARK_MAX_BYTES, MUSIC_MAX_BYTES, type WatermarkRow,
} from '../services/assets.js';
import {
  listBroll, getBroll, createBroll, updateBroll, deleteBroll, BROLL_MAX_VIDEO_BYTES,
} from '../services/broll.js';
import { listSfx, getSfx, createSfx, updateSfx, deleteSfx, SFX_MAX_BYTES } from '../services/sfx.js';

export const assetsRouter = Router();
assetsRouter.use(requireAuth);

function assetUpload(maxBytes: number, field: string) {
  return multer({
    storage: multer.diskStorage({
      destination: config.dirs.input,
      filename: (_req, file, cb) => cb(null, `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, cb) => {
      // real validation (extension/magic bytes) happens in the service layer
      if (!file.originalname || file.originalname.length > 255) return cb(new Error('invalid file name'));
      cb(null, true);
    },
  }).single(field);
}

const MAX_MB = (n: number) => Math.round(n / 1e6);

/* ---------------- watermarks ---------------- */

assetsRouter.get('/watermarks', (_req, res) => {
  res.json({ watermarks: listWatermarks() });
});

assetsRouter.post('/watermarks', (req, res, next) => {
  assetUpload(WATERMARK_MAX_BYTES, 'file')(req, res, (err) => {
    if (err) {
      const e = err as { code?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `file too large (max ${MAX_MB(WATERMARK_MAX_BYTES)}MB)` });
      return next(err);
    }
    (async () => {
      const f = (req as unknown as { file?: { path: string; originalname: string } }).file;
      if (!f) return res.status(400).json({ error: 'no file uploaded (field: "file")' });
      const b = req.body ?? {};
      const defaults: Partial<WatermarkRow> = {
        name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : undefined,
        default_position: typeof b.position === 'string' ? (b.position as WatermarkRow['default_position']) : undefined,
        width_percent: b.width_percent !== undefined ? Number(b.width_percent) : undefined,
        opacity: b.opacity !== undefined ? Number(b.opacity) : undefined,
        margin: b.margin !== undefined ? Number(b.margin) : undefined,
      };
      const wm = await createWatermark(f.path, f.originalname, defaults);
      res.status(201).json({ watermark: wm });
    })().catch(next);
  });
});

assetsRouter.patch('/watermarks/:id', (req, res, next) => {
  try {
    const updated = updateWatermark(String(req.params.id), req.body ?? {});
    if (!updated) return res.status(404).json({ error: 'watermark not found' });
    res.json({ watermark: updated });
  } catch (e) {
    next(e);
  }
});

assetsRouter.delete('/watermarks/:id', (req, res, next) => {
  try {
    if (!deleteWatermark(String(req.params.id))) return res.status(404).json({ error: 'watermark not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ---------------- music library ---------------- */

assetsRouter.get('/music', (_req, res) => {
  res.json({ music: listMusic() });
});

assetsRouter.post('/music', (req, res, next) => {
  assetUpload(MUSIC_MAX_BYTES, 'file')(req, res, (err) => {
    if (err) {
      const e = err as { code?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `file too large (max ${MAX_MB(MUSIC_MAX_BYTES)}MB)` });
      return next(err);
    }
    (async () => {
      const f = (req as unknown as { file?: { path: string; originalname: string } }).file;
      if (!f) return res.status(400).json({ error: 'no file uploaded (field: "file")' });
      const b = req.body ?? {};
      const num = (v: unknown) => (v === undefined || v === '' || v === null ? undefined : Number(v));
      const music = await createMusic(f.path, f.originalname, {
        name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : undefined,
        mood: typeof b.mood === 'string' && b.mood.trim() ? b.mood.trim().slice(0, 40) : null,
        genre: typeof b.genre === 'string' && b.genre.trim() ? b.genre.trim().slice(0, 40) : null,
        energy: num(b.energy),
        bpm: num(b.bpm),
        license: typeof b.license === 'string' ? b.license.slice(0, 200) : null,
        attribution: typeof b.attribution === 'string' ? b.attribution.slice(0, 300) : null,
      });
      res.status(201).json({ music });
    })().catch(next);
  });
});

assetsRouter.patch('/music/:id', (req, res, next) => {
  try {
    const updated = updateMusic(String(req.params.id), req.body ?? {});
    if (!updated) return res.status(404).json({ error: 'music asset not found' });
    res.json({ music: updated });
  } catch (e) {
    next(e);
  }
});

assetsRouter.delete('/music/:id', (req, res, next) => {
  try {
    if (!deleteMusic(String(req.params.id))) return res.status(404).json({ error: 'music asset not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

assetsRouter.get('/music/:id', (req, res) => {
  const m = getMusic(String(req.params.id));
  if (!m) return res.status(404).json({ error: 'music asset not found' });
  res.json({ music: m });
});

assetsRouter.get('/watermarks/:id', (req, res) => {
  const w = getWatermark(String(req.params.id));
  if (!w) return res.status(404).json({ error: 'watermark not found' });
  res.json({ watermark: w });
});

/* ---------------- b-roll library ---------------- */

assetsRouter.get('/broll', (_req, res) => {
  res.json({ broll: listBroll() });
});

assetsRouter.get('/broll/:id', (req, res) => {
  const b = getBroll(String(req.params.id));
  if (!b) return res.status(404).json({ error: 'b-roll asset not found' });
  res.json({ broll: b });
});

assetsRouter.post('/broll', (req, res, next) => {
  assetUpload(BROLL_MAX_VIDEO_BYTES, 'file')(req, res, (err) => {
    if (err) {
      const e = err as { code?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `file too large (max ${MAX_MB(BROLL_MAX_VIDEO_BYTES)}MB)` });
      return next(err);
    }
    (async () => {
      const f = (req as unknown as { file?: { path: string; originalname: string } }).file;
      if (!f) return res.status(400).json({ error: 'no file uploaded (field: "file")' });
      const b = req.body ?? {};
      const broll = await createBroll(f.path, f.originalname, {
        name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : undefined,
        tags: typeof b.tags === 'string' ? b.tags.slice(0, 300) : undefined,
        license: typeof b.license === 'string' ? b.license.slice(0, 200) : undefined,
        attribution: typeof b.attribution === 'string' ? b.attribution.slice(0, 300) : undefined,
      });
      res.status(201).json({ broll });
    })().catch(next);
  });
});

assetsRouter.patch('/broll/:id', (req, res, next) => {
  try {
    const updated = updateBroll(String(req.params.id), req.body ?? {});
    if (!updated) return res.status(404).json({ error: 'b-roll asset not found' });
    res.json({ broll: updated });
  } catch (e) {
    next(e);
  }
});

assetsRouter.delete('/broll/:id', (req, res, next) => {
  try {
    if (!deleteBroll(String(req.params.id))) return res.status(404).json({ error: 'b-roll asset not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ---------------- sfx library ---------------- */

assetsRouter.get('/sfx', (_req, res) => {
  res.json({ sfx: listSfx() });
});

assetsRouter.get('/sfx/:id', (req, res) => {
  const s = getSfx(String(req.params.id));
  if (!s) return res.status(404).json({ error: 'sfx asset not found' });
  res.json({ sfx: s });
});

assetsRouter.post('/sfx', (req, res, next) => {
  assetUpload(SFX_MAX_BYTES, 'file')(req, res, (err) => {
    if (err) {
      const e = err as { code?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `file too large (max ${MAX_MB(SFX_MAX_BYTES)}MB)` });
      return next(err);
    }
    (async () => {
      const f = (req as unknown as { file?: { path: string; originalname: string } }).file;
      if (!f) return res.status(400).json({ error: 'no file uploaded (field: "file")' });
      const b = req.body ?? {};
      const sfx = await createSfx(f.path, f.originalname, {
        name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : undefined,
        tags: typeof b.tags === 'string' ? b.tags.slice(0, 300) : undefined,
        license: typeof b.license === 'string' ? b.license.slice(0, 200) : undefined,
        attribution: typeof b.attribution === 'string' ? b.attribution.slice(0, 300) : undefined,
      });
      res.status(201).json({ sfx });
    })().catch(next);
  });
});

assetsRouter.patch('/sfx/:id', (req, res, next) => {
  try {
    const updated = updateSfx(String(req.params.id), req.body ?? {});
    if (!updated) return res.status(404).json({ error: 'sfx asset not found' });
    res.json({ sfx: updated });
  } catch (e) {
    next(e);
  }
});

assetsRouter.delete('/sfx/:id', (req, res, next) => {
  try {
    if (!deleteSfx(String(req.params.id))) return res.status(404).json({ error: 'sfx asset not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
