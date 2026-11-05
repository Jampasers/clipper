import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { config } from '../config.js';
import { requireAuth } from '../lib/middleware.js';
import { logger } from '../lib/log.js';
import { nanoid } from 'nanoid';
import {
  ASSET_KINDS, FONT_EXTS, IMAGE_EXTS, createDesignAsset, designAssetDir, getDesignAsset,
  listDesignAssets, listDesignFonts, resolveDesignAsset, updateDesignAsset, deleteDesignAsset,
  assetReferences, type AssetKind, type DesignAssetRow,
} from '../services/design-assets.js';
import { getSettings } from '../lib/settings.js';
import { testImageProvider, imageProviderStatus } from '../services/image-provider.js';

/**
 * Design asset library API (images/logos/backgrounds/textures/fonts).
 * Files live under storage/assets/design and are served through the
 * authenticated /media/design-assets scope; documents only ever store ids.
 */

export const designAssetsRouter = Router();
designAssetsRouter.use(requireAuth);

const uploadSingle = () =>
  multer({
    storage: multer.diskStorage({
      destination: designAssetDir(),
      filename: (_req, file, cb) => cb(null, `tmp_${nanoid(8)}${path.extname(file.originalname ?? '').toLowerCase()}`),
    }),
    limits: { fileSize: getSettings('design').max_asset_bytes },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname ?? '').toLowerCase();
      if (!file.originalname || file.originalname.length > 255) return cb(new Error('invalid file name'));
      if (!IMAGE_EXTS.has(ext) && !FONT_EXTS.has(ext)) return cb(new Error(`unsupported asset format "${ext}"`));
      cb(null, true);
    },
  }).single('file');

/** Strip filesystem paths; assets are addressed by id + media scope only. */
function view(row: DesignAssetRow) {
  const { file_path, thumbnail_path, ...rest } = row;
  void file_path;
  void thumbnail_path;
  return { ...rest, url: `/media/design-assets/${row.file_path.replace(/^.*[\\/]/, '')}` };
}

designAssetsRouter.get('/', (req, res, next) => {
  try {
    res.json({
      assets: listDesignAssets({
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        enabledOnly: req.query.enabled === '1',
      }).map(view),
      kinds: ASSET_KINDS,
    });
  } catch (e) { next(e); }
});

designAssetsRouter.get('/fonts', (_req, res) => {
  res.json({ fonts: listDesignFonts() });
});

designAssetsRouter.get('/image-provider', (_req, res) => {
  res.json({ provider: imageProviderStatus() });
});

designAssetsRouter.post('/image-provider/test', async (_req, res, next) => {
  try {
    const result = await testImageProvider();
    res.json(result);
  } catch (e) { next(e); }
});

designAssetsRouter.post('/', (req, res, next) => {
  uploadSingle()(req, res, async (err) => {
    if (err) return next(Object.assign(err, { status: 400 }));
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required' });
    try {
      const kind = ASSET_KINDS.includes(req.body?.kind) && req.body.kind !== 'font' ? (req.body.kind as AssetKind) : FONT_EXTS.has(path.extname(file.filename).toLowerCase()) ? 'font' : 'image';
      const row = await createDesignAsset(file.path, file.originalname, {
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        kind,
        tags: typeof req.body?.tags === 'string' ? req.body.tags.slice(0, 300) : undefined,
      });
      logger.info('DESIGN', `asset uploaded via API: ${row.id} (${row.kind})`);
      res.status(201).json({ asset: view(row) });
    } catch (e) {
      next(Object.assign(e as Error, { status: 400 }));
    }
  });
});

designAssetsRouter.patch('/:id', (req, res, next) => {
  try {
    const row = updateDesignAsset(String(req.params.id), req.body ?? {});
    if (!row) return res.status(404).json({ error: 'asset not found' });
    res.json({ asset: view(row) });
  } catch (e) { next(e); }
});

designAssetsRouter.get('/:id/references', (req, res) => {
  const row = resolveDesignAsset(String(req.params.id)) ?? getDesignAsset(String(req.params.id));
  if (!row) return res.status(404).json({ error: 'asset not found' });
  res.json(assetReferences(row.id));
});

designAssetsRouter.delete('/:id', (req, res, next) => {
  try {
    const force = req.query.force === '1' || req.body?.force === true;
    const ok = deleteDesignAsset(String(req.params.id), force);
    if (!ok) return res.status(404).json({ error: 'asset not found' });
    res.json({ ok });
  } catch (e) { next(e); }
});
