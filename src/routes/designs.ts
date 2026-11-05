import { Router } from 'express';
import { requireAuth } from '../lib/middleware.js';
import { logger } from '../lib/log.js';
import { designDocumentSchema, parseDesignDocument, DesignSchemaError, type DesignDocument } from '../design/document.js';
import { renderDocumentSvg } from '../design/render.js';
import { exportDesign, writeThumbnail, EXPORT_FORMATS, type ExportFormat } from '../design/export.js';
import { resolveDesignAsset, resolveFont } from '../services/design-assets.js';
import {
  createDesign, getDesign, getDesignRow, listDesigns, saveDesign, deleteDesign, duplicateDesign,
  listVersions, restoreVersion, listReviews, summarizeRow,
  listTemplates, getTemplate, createTemplate, applyTemplate, duplicateTemplate, deleteTemplate,
  DesignNotFoundError,
} from '../services/designs.js';
import {
  enqueueDesignGeneration, enqueueDesignVariants, enqueueDesignReview, enqueueDesignRepair,
  listGenerations, type GenerationOptions,
} from '../services/design-jobs.js';

/**
 * Design Studio API. Documents are saved as validated DesignDocument JSON;
 * preview/export always go through the same server renderer so the editor,
 * thumbnails and exports cannot drift apart.
 */

export const designsRouter = Router();
designsRouter.use(requireAuth);

function assetHref(a: { assetId: string }): string | null {
  const row = resolveDesignAsset(a.assetId);
  if (!row) return null;
  return `/media/design-assets/${row.file_path.replace(/^.*[\\/]/, '')}`;
}

function fontHref(family: string): { href: string; mime: string } | null {
  const font = resolveFont(family);
  if (!font) return null;
  return { href: `/media/design-assets/${font.filePath.replace(/^.*[\\/]/, '')}`, mime: font.mime };
}

function renderPreview(doc: DesignDocument): string {
  return renderDocumentSvg(doc, { mode: 'preview', assetHref, fontHref });
}

function resolvers() {
  return {
    resolveAssetFile: (id: string) => {
      const row = resolveDesignAsset(id);
      return row ? { filePath: row.file_path, mime: row.mime } : null;
    },
    resolveFontFile: (family: string) => resolveFont(family) ?? null,
  };
}

function asGenerationOptions(body: Record<string, unknown>): GenerationOptions {
  return {
    brief: typeof body.brief === 'string' ? body.brief.slice(0, 8000) : undefined,
    width: Number(body.width) || undefined,
    height: Number(body.height) || undefined,
    roles: Array.isArray(body.roles) ? body.roles.map(String) : undefined,
    generateImage: body.generateImage === undefined ? undefined : Boolean(body.generateImage),
    strategy: typeof body.strategy === 'string' ? (body.strategy as GenerationOptions['strategy']) : undefined,
    palette: Array.isArray(body.palette) ? body.palette.map(String) : undefined,
    brand: typeof body.brand === 'string' ? body.brand.slice(0, 4000) : undefined,
    variant: Number(body.variant) || undefined,
  };
}

designsRouter.get('/', (req, res, next) => {
  try {
    res.json({
      designs: listDesigns({
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
      }),
    });
  } catch (e) { next(e); }
});

designsRouter.post('/', (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const width = Number(body.width) || 1080;
    const height = Number(body.height) || 1080;
    const row = createDesign({
      name: typeof body.name === 'string' ? body.name.slice(0, 200) : undefined,
      width,
      height,
      brief: typeof body.brief === 'string' ? body.brief.slice(0, 8000) : undefined,
      category: typeof body.category === 'string' ? body.category.slice(0, 60) : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String).join(',') : undefined,
      status: body.generate ? 'generating' : 'draft',
    });
    let jobId: string | null = null;
    if (body.generate) {
      jobId = enqueueDesignGeneration(row.id, { ...asGenerationOptions(body), width, height });
    }
    logger.info('DESIGN', `design create API: ${row.id}${jobId ? ` (job ${jobId})` : ''}`);
    res.status(201).json({ design: summarizeRow(getDesignRow(row.id)!), jobId });
  } catch (e) { next(e); }
});

designsRouter.post('/preview', (req, res, next) => {
  try {
    const parsed = designDocumentSchema.safeParse(req.body?.document ?? req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid document' });
    res.type('image/svg+xml').send(renderPreview(parsed.data));
  } catch (e) { next(e); }
});

designsRouter.get('/:id', (req, res, next) => {
  try {
    const { row, doc } = getDesign(String(req.params.id));
    res.json({ design: summarizeRow(row), document: doc, box: { width: row.width, height: row.height } });
  } catch (e) { next(e); }
});

designsRouter.put('/:id', (req, res, next) => {
  try {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body.document ?? body;
    const saved = saveDesign(id, raw, {
      name: typeof body.name === 'string' ? body.name : undefined,
      label: typeof body.label === 'string' ? body.label.slice(0, 120) : 'manual save',
    });
    res.json({ design: summarizeRow(saved.row), document: saved.doc });
  } catch (e) { next(e); }
});

designsRouter.delete('/:id', (req, res) => {
  const ok = deleteDesign(String(req.params.id));
  if (!ok) return res.status(404).json({ error: 'design not found' });
  res.json({ ok });
});

designsRouter.post('/:id/duplicate', (req, res, next) => {
  try {
    const { row, doc } = duplicateDesign(String(req.params.id), typeof req.body?.name === 'string' ? req.body.name : undefined);
    res.status(201).json({ design: summarizeRow(row), document: doc });
  } catch (e) { next(e); }
});

designsRouter.post('/:id/generate', (req, res, next) => {
  try {
    const row = getDesignRow(String(req.params.id));
    if (!row) throw new DesignNotFoundError();
    const opts = asGenerationOptions((req.body ?? {}) as Record<string, unknown>);
    const jobId = enqueueDesignGeneration(row.id, opts);
    res.json({ jobId });
  } catch (e) { next(e); }
});

designsRouter.post('/:id/variants', (req, res, next) => {
  try {
    const row = getDesignRow(String(req.params.id));
    if (!row) throw new DesignNotFoundError();
    const jobId = enqueueDesignVariants(row.id, Number(req.body?.count) || 3);
    res.json({ jobId });
  } catch (e) { next(e); }
});

designsRouter.post('/:id/review', (req, res, next) => {
  try {
    const row = getDesignRow(String(req.params.id));
    if (!row) throw new DesignNotFoundError();
    res.json({ jobId: enqueueDesignReview(row.id, Boolean(req.body?.ai)) });
  } catch (e) { next(e); }
});

designsRouter.post('/:id/repair', (req, res, next) => {
  try {
    const row = getDesignRow(String(req.params.id));
    if (!row) throw new DesignNotFoundError();
    res.json({ jobId: enqueueDesignRepair(row.id) });
  } catch (e) { next(e); }
});

designsRouter.get('/:id/versions', (req, res, next) => {
  try {
    res.json({ versions: listVersions(String(req.params.id)) });
  } catch (e) { next(e); }
});

designsRouter.post('/:id/versions/:revision/restore', (req, res, next) => {
  try {
    const { row, doc } = restoreVersion(String(req.params.id), Number(req.params.revision));
    res.json({ design: summarizeRow(row), document: doc });
  } catch (e) { next(e); }
});

designsRouter.get('/:id/reviews', (req, res, next) => {
  try {
    res.json({ reviews: listReviews(String(req.params.id)) });
  } catch (e) { next(e); }
});

designsRouter.get('/:id/generations', (req, res, next) => {
  try {
    res.json({ generations: listGenerations(String(req.params.id)) });
  } catch (e) { next(e); }
});

designsRouter.get('/:id/preview.svg', (req, res, next) => {
  try {
    const { doc } = getDesign(String(req.params.id));
    res.type('image/svg+xml').send(renderPreview(doc));
  } catch (e) { next(e); }
});

designsRouter.post('/:id/thumbnail', async (req, res, next) => {
  try {
    const { row, doc } = getDesign(String(req.params.id));
    let thumbnailPath: string | null = null;
    try {
      thumbnailPath = await writeThumbnail(doc, resolvers().resolveAssetFile);
    } catch (err) {
      logger.warn('DESIGN', `manual thumbnail failed: ${String((err as Error).message).slice(0, 160)}`);
    }
    if (thumbnailPath) {
      saveDesign(row.id, doc, { thumbnailPath, label: 'auto (before thumbnail refresh)' });
    }
    res.json({ thumbnail: thumbnailPath ? `/media/design-thumbs/${thumbnailPath.replace(/^.*[\\/]/, '')}` : null });
  } catch (e) { next(e); }
});

designsRouter.post('/:id/export', async (req, res, next) => {
  try {
    const { doc } = getDesign(String(req.params.id));
    const format = EXPORT_FORMATS.includes(req.body?.format as ExportFormat) ? (req.body.format as ExportFormat) : doc.settings.export.format;
    const result = await exportDesign(doc, {
      format,
      scale: Number(req.body?.scale) || doc.settings.export.scale,
      quality: Number(req.body?.quality) || doc.settings.export.quality,
      ...resolvers(),
    });
    res.json({
      export: {
        format: result.format,
        fileName: result.fileName,
        mime: result.mime,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        url: `/media/design-exports/${encodeURIComponent(result.fileName)}`,
      },
    });
  } catch (e) { next(e); }
});

/* ---------------- templates ---------------- */

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

templatesRouter.get('/', (req, res, next) => {
  try {
    res.json({ templates: listTemplates(typeof req.query.category === 'string' ? req.query.category : undefined) });
  } catch (e) { next(e); }
});

templatesRouter.post('/', (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let document = body.document;
    if (!document && typeof body.designId === 'string') document = getDesign(body.designId).doc;
    if (!document) return res.status(400).json({ error: 'provide a designId or a document' });
    const template = createTemplate({
      name: typeof body.name === 'string' && body.name.trim() ? body.name : 'Template',
      document,
      category: typeof body.category === 'string' ? body.category : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String).join(',') : undefined,
    });
    res.status(201).json({ template: { ...template, document: undefined } });
  } catch (e) { next(e); }
});

templatesRouter.get('/:id', (req, res, next) => {
  try {
    const t = getTemplate(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'template not found' });
    res.json({ template: { ...t, document: parseDesignDocument(JSON.parse(t.document)) } });
  } catch (e) { next(e); }
});

templatesRouter.post('/:id/apply', (req, res, next) => {
  try {
    const { row, doc } = applyTemplate(String(req.params.id), {
      designId: typeof req.body?.designId === 'string' ? req.body.designId : undefined,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
    });
    res.status(201).json({ design: summarizeRow(row), document: doc });
  } catch (e) { next(e); }
});

templatesRouter.post('/:id/duplicate', (req, res, next) => {
  try {
    const t = duplicateTemplate(String(req.params.id), typeof req.body?.name === 'string' ? req.body.name : undefined);
    res.status(201).json({ template: { ...t, document: undefined } });
  } catch (e) { next(e); }
});

templatesRouter.delete('/:id', (req, res, next) => {
  try {
    res.json({ ok: deleteTemplate(String(req.params.id)) });
  } catch (e) { next(e); }
});
