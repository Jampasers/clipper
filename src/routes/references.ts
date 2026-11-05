import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { requireAuth } from '../lib/middleware.js';
import { J } from '../lib/sqlite.js';
import { getSettings } from '../lib/settings.js';
import { enqueue } from '../lib/queue.js';
import { logger } from '../lib/log.js';
import { ytdlpMeta } from '../lib/ytdlp.js';
import {
  REFERENCE_EXTS, createDownloadingReference, createReference, deleteReference, getLatestAnalysis, getReference,
  listCategories, listReferences, referenceView, updateReference,
} from '../services/reference-library.js';
import { enqueueReferenceAnalysis, analyzeNow } from '../services/reference-jobs.js';
import type { StyleProfile } from '../services/style-profile.js';

export const referencesRouter = Router();
referencesRouter.use(requireAuth);

// Built per request: the size limit comes from settings, and settings require
// an initialized DB (module import must not touch the database).
const uploadSingle = () =>
  multer({
    storage: multer.diskStorage({
      destination: config.dirs.input,
      filename: (_req, file, cb) =>
        cb(null, `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: getSettings('learning').max_reference_bytes },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname ?? '').toLowerCase();
      if (!file.originalname || file.originalname.length > 255) return cb(new Error('invalid file name'));
      if (!REFERENCE_EXTS.has(ext)) return cb(new Error(`unsupported video format "${ext}"`));
      cb(null, true);
    },
  }).single('file');

function parseTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) return j.map(String);
    } catch {
      /* comma-separated fallback */
    }
    return raw.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

referencesRouter.get('/', (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { references, total } = listReferences({
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      search: typeof req.query.q === 'string' ? req.query.q : undefined,
      enabledOnly: req.query.enabled === '1',
      limit,
      offset,
    });
    res.json({ references: references.map(referenceView), total, categories: listCategories() });
  } catch (e) {
    next(e);
  }
});

referencesRouter.get('/categories', (_req, res) => {
  res.json({ categories: listCategories() });
});

referencesRouter.post('/', (req, res, next) => {
  uploadSingle()(req, res, (err) => {
    if (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `file too large (max ${Math.round(getSettings('learning').max_reference_bytes / 1e6)}MB)` });
      }
      return next(err);
    }
    (async () => {
      const f = (req as unknown as { file?: { path: string; originalname: string } }).file;
      if (!f) return res.status(400).json({ error: 'no file uploaded (field: "file")' });
      const b = req.body ?? {};
      const ref = await createReference(f.path, f.originalname, {
        name: typeof b.name === 'string' ? b.name : undefined,
        description: typeof b.description === 'string' ? b.description : undefined,
        category: typeof b.category === 'string' ? b.category : undefined,
        tags: parseTags(b.tags),
      });
      const learning = getSettings('learning');
      let jobId: string | null = null;
      if (learning.auto_analyze) {
        jobId = enqueueReferenceAnalysis(ref.id);
      }
      res.status(201).json({ reference: referenceView(ref), analysisJobId: jobId });
    })().catch(next);
  });
});

referencesRouter.post('/url', async (req, res, next) => {
  try {
    const raw = String((req.body ?? {}).url ?? '').trim();
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'invalid URL' }); }
    if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'only http(s) URLs are supported' });
    const yt = await ytdlpMeta(parsed.href).catch((e) => {
      throw new Error(`Could not read that video: ${(e as Error).message}`);
    });
    const b = req.body ?? {};
    const ref = createDownloadingReference({
      url: parsed.href,
      name: (typeof b.name === 'string' && b.name.trim()) || yt.title || undefined,
      description: typeof b.description === 'string' ? b.description : undefined,
      category: typeof b.category === 'string' ? b.category : undefined,
      tags: parseTags(b.tags),
    });
    const jobId = enqueue('reference_download', { payload: { referenceId: ref.id, url: parsed.href } });
    logger.info('VIDEO', `reference link queued: ${ref.id} <- ${parsed.hostname}`);
    res.status(201).json({ reference: referenceView(ref), downloadJobId: jobId });
  } catch (e) {
    next(e);
  }
});

referencesRouter.get('/:id', (req, res, next) => {
  try {
    const row = getReference(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'reference not found' });
    const analysis = getLatestAnalysis(row.id);
    res.json({
      reference: referenceView(row),
      analysis: analysis
        ? {
            status: analysis.status,
            profileVersion: analysis.profile_version,
            analysisVersion: analysis.analysis_version,
            profile: analysis.profile ? (J.read<StyleProfile>(analysis.profile) ?? null) : null,
            measurements: analysis.measurements ? J.read<unknown>(analysis.measurements) : null,
            evidence: analysis.evidence ? J.read<unknown>(analysis.evidence) : null,
            model: analysis.model,
            error: analysis.error,
            createdAt: analysis.created_at,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

referencesRouter.patch('/:id', (req, res, next) => {
  try {
    const b = req.body ?? {};
    const updated = updateReference(String(req.params.id), {
      name: typeof b.name === 'string' ? b.name : undefined,
      description: b.description === undefined ? undefined : b.description === null ? null : String(b.description),
      category: b.category === undefined ? undefined : b.category === null ? null : String(b.category),
      tags: parseTags(b.tags),
      enabled: b.enabled === undefined ? undefined : !!b.enabled,
    });
    if (!updated) return res.status(404).json({ error: 'reference not found' });
    res.json({ reference: referenceView(updated) });
  } catch (e) {
    next(e);
  }
});

referencesRouter.delete('/:id', (req, res, next) => {
  try {
    if (!deleteReference(String(req.params.id))) return res.status(404).json({ error: 'reference not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

referencesRouter.post('/:id/analyze', (req, res, next) => {
  (async () => {
    const id = String(req.params.id);
    if (!getReference(id)) return res.status(404).json({ error: 'reference not found' });
    const force = !!(req.body?.force);
    if (req.query.sync === '1' || req.body?.sync === true) {
      await analyzeNow(id);
      const row = getReference(id)!;
      return res.json({ reference: referenceView(row), analysisJobId: null, synced: true });
    }
    const jobId = enqueueReferenceAnalysis(id, force);
    res.status(202).json({ ok: true, analysisJobId: jobId });
  })().catch(next);
});

referencesRouter.get('/:id/thumbnail', (req, res, next) => {
  try {
    const row = getReference(String(req.params.id));
    if (!row?.thumbnail_path || !fs.existsSync(row.thumbnail_path)) {
      return res.status(404).json({ error: 'no thumbnail' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.resolve(row.thumbnail_path));
  } catch (e) {
    next(e);
  }
});

referencesRouter.get('/:id/source', (req, res, next) => {
  try {
    const row = getReference(String(req.params.id));
    if (!row || !fs.existsSync(row.source_path)) return res.status(404).json({ error: 'reference source not found' });
    res.setHeader('Content-Type', row.mime || 'video/mp4');
    res.sendFile(path.resolve(row.source_path));
  } catch (e) {
    next(e);
  }
});
