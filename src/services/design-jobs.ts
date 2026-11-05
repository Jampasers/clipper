import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { enqueue, registerHandler, type JobRow } from '../lib/queue.js';
import { q, J } from '../lib/sqlite.js';
import { logger } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { config } from '../config.js';
import { generateImage, ImageGenerationUnavailableError, getImageProvider, imageProviderStatus } from './image-provider.js';
import { registerGeneratedAsset, resolveDesignAsset, listDesignFonts, resolveFont } from './design-assets.js';
import {
  getDesign, getDesignRow, saveDesign, setDesignStatus, createDesign, saveReview,
} from './designs.js';
import {
  analyzeBrief, getArtDirection, planCopy, variantDirections, fallbackArtDirection, DEFAULT_ROLES,
  type BriefAnalysis,
} from '../design/artdir.js';
import {
  buildLayout, ROLES, STRATEGY_ROTATION,
  type ArtDirection, type Composition, type ContentBlock, type ImageSlot, type TextRole,
} from '../design/layout.js';
import { deterministicRepair, reviewDesignAi, reviewDesignDeterministic } from '../design/review.js';
import { exportDesign, writeThumbnail, EXPORT_FORMATS, type ExportFormat } from '../design/export.js';
import { rasterizeSvgToImage } from '../lib/remotion-bundle.js';
import { renderDocumentSvg } from '../design/render.js';
import type { DesignDocument } from '../design/document.js';
import type { VisionImage } from '../lib/ai.js';

/**
 * Design lane worker handlers.
 *
 * Generation pipeline: brief analysis -> art direction -> copy -> optional
 * image-provider background -> deterministic layout -> bounded repair ->
 * persist + thumbnail + review. Every AI step has a deterministic fallback,
 * so generation works with no AI configured at all; the image provider is the
 * only optional paid dependency and its absence is reported, never faked.
 */

export interface GenerationOptions {
  brief?: string;
  width?: number;
  height?: number;
  roles?: string[];
  generateImage?: boolean;
  strategy?: Composition;
  palette?: string[];
  brand?: string;
  variant?: number;
}

interface GenerationPlan {
  analysis: BriefAnalysis;
  direction: ArtDirection;
  blocks: ContentBlock[];
  doc: DesignDocument;
  bgDocAsset?: { id: string; assetId: string; name: string; mime: string; width?: number; height?: number };
  warnings: string[];
}

function normalizeRoles(input?: string[]): TextRole[] {
  const allowed = new Set<string>(ROLES);
  const roles = (input ?? DEFAULT_ROLES).filter((r): r is TextRole => allowed.has(r));
  return roles.includes('headline') ? roles : ['headline', ...roles];
}

function resolveAssetFile(libraryAssetId: string): { filePath: string; mime: string } | null {
  const row = resolveDesignAsset(libraryAssetId);
  return row ? { filePath: row.file_path, mime: row.mime } : null;
}

function reviewContext() {
  return {
    assetInfo: (libraryAssetId: string) => {
      const row = resolveDesignAsset(libraryAssetId);
      return row ? { width: row.width, height: row.height } : null;
    },
    customFonts: listDesignFonts().map((f) => f.family),
  };
}

/* ---------------- generation records ---------------- */

function startGeneration(designId: string | null, kind: string, brief: string | null, options: unknown): string {
  const id = nanoid(12);
  q.run(
    `INSERT INTO design_generations (id, design_id, kind, brief, options) VALUES (?,?,?,?,?)`,
    id,
    designId,
    kind,
    brief,
    options != null ? JSON.stringify(options) : null
  );
  return id;
}

function finishGeneration(id: string, status: 'done' | 'failed', result?: unknown, error?: string): void {
  q.run(
    "UPDATE design_generations SET status = ?, result = ?, error = ?, finished_at = datetime('now') WHERE id = ?",
    status,
    result !== undefined ? JSON.stringify(result) : null,
    error ? error.slice(0, 800) : null,
    id
  );
}

export function listGenerations(designId: string, limit = 30) {
  return q
    .all<{ id: string; kind: string; status: string; result: string | null; error: string | null; created_at: string; finished_at: string | null }>(
      'SELECT id, kind, status, result, error, created_at, finished_at FROM design_generations WHERE design_id = ? ORDER BY created_at DESC LIMIT ?',
      designId,
      limit
    )
    .map((r) => ({ id: r.id, kind: r.kind, status: r.status, result: J.read(r.result), error: r.error, createdAt: r.created_at, finishedAt: r.finished_at }));
}

/* ---------------- pipeline ---------------- */

async function buildPlan(opts: GenerationOptions, designId: string, brief: string, W: number, H: number, ctx: { report: (p: number) => void }): Promise<GenerationPlan> {
  const warnings: string[] = [];
  ctx.report(8);
  const analysis = await analyzeBrief(brief, `${W}x${H}`, opts.brand ?? '');
  ctx.report(24);
  const direction = await getArtDirection(analysis, brief, W, H, (opts.palette ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)));
  if (opts.strategy && STRATEGY_ROTATION.includes(opts.strategy)) direction.composition = opts.strategy;
  ctx.report(40);
  const blocks = await planCopy(brief, analysis, direction, normalizeRoles(opts.roles));
  ctx.report(55);

  let bgDocAsset: GenerationPlan['bgDocAsset'];
  const design = getSettings('design');
  if (direction.background === 'image' && opts.generateImage !== false && design.generate_backgrounds && getImageProvider()) {
    try {
      const image = await generateImage({
        prompt: direction.image_prompt || `abstract background for: ${brief.slice(0, 400)}`,
        width: W,
        height: H,
      });
      const row = await registerGeneratedAsset(image.filePath, {
        name: `${designId}-bg`,
        mime: image.mime,
        prompt: image.prompt,
        generator: image.model,
        kind: 'background',
      });
      bgDocAsset = { id: `bg-${nanoid(6)}`, assetId: row.id, name: row.name, mime: row.mime, width: row.width ?? undefined, height: row.height ?? undefined };
      logger.info('DESIGN', `generated background for ${designId} via ${image.model} (${image.width}x${image.height})`);
    } catch (err) {
      const msg = err instanceof ImageGenerationUnavailableError ? err.message : String((err as Error).message).slice(0, 200);
      warnings.push(`image generation failed, using gradient fallback: ${msg}`);
      logger.warn('DESIGN', `image generation failed for ${designId}: ${msg}`);
      direction.background = 'gradient';
    }
  } else if (direction.background === 'image') {
    warnings.push(design.generate_backgrounds ? 'image provider not configured; using gradient fallback' : 'background image generation disabled; using gradient fallback');
    direction.background = 'gradient';
  }
  ctx.report(62);

  const images: ImageSlot[] = bgDocAsset ? [{ assetRef: bgDocAsset.id, role: 'background' }] : [];
  const { doc, warnings: layoutWarnings } = buildLayout({
    id: designId,
    canvas: { width: W, height: H },
    direction,
    blocks,
    images,
    variant: opts.variant ?? 0,
  });
  warnings.push(...layoutWarnings);

  if (bgDocAsset) {
    doc.assets = [{ id: bgDocAsset.id, assetId: bgDocAsset.assetId, name: bgDocAsset.name, mime: bgDocAsset.mime, width: bgDocAsset.width, height: bgDocAsset.height, source: 'generated' }];
    doc.canvas.background = { mode: 'image', assetRef: bgDocAsset.id, blur: 0 };
  }
  doc.metadata.brief = brief;
  doc.metadata.generation = {
    model: imageProviderStatus().model || undefined,
    artDirection: JSON.stringify({ concept: direction.concept, rationale: direction.rationale }).slice(0, 4000),
    generatedAt: new Date().toISOString(),
  };
  return { analysis, direction, blocks, doc, bgDocAsset, warnings };
}

async function finalizeDesign(designId: string, doc: DesignDocument, warnings: string[], ctx: { report: (p: number) => void }): Promise<DesignDocument> {
  const design = getSettings('design');
  let finalDoc = doc;
  if (design.review.deterministic && design.review.auto_repair) {
    const repair = deterministicRepair(finalDoc);
    if (repair.applied.length) {
      logger.info('DESIGN', `auto-repair applied ${repair.applied.length} fix(es) to ${designId}`);
      finalDoc = repair.doc;
    }
    if (repair.rejected.length) warnings.push(...repair.rejected.slice(0, 5).map((r) => `repair rejected: ${r.reason}`));
  }
  ctx.report(78);

  let thumbnailPath: string | null = null;
  try {
    thumbnailPath = await writeThumbnail(finalDoc, resolveAssetFile);
  } catch (err) {
    logger.warn('DESIGN', `thumbnail render failed for ${designId}: ${String((err as Error).message).slice(0, 160)}`);
  }
  ctx.report(86);

  const saved = saveDesign(designId, finalDoc, { status: 'ready', label: 'auto (before generation commit)', thumbnailPath });
  const review = reviewDesignDeterministic(saved.doc, reviewContext());
  saveReview(designId, saved.row.revision, 'deterministic', review.score, review);
  if (warnings.length) logger.info('DESIGN', `generation warnings for ${designId}: ${warnings.slice(0, 4).join(' | ')}`);
  ctx.report(96);
  return saved.doc;
}

/* ---------------- enqueue helpers ---------------- */

export function enqueueDesignGeneration(designId: string, opts: GenerationOptions = {}): string {
  return enqueue('design_generate', { payload: { designId, ...opts } });
}

export function enqueueDesignVariants(designId: string, count = 3): string {
  return enqueue('design_variants', { payload: { designId, count } });
}

export function enqueueDesignReview(designId: string, ai = false): string {
  return enqueue('design_review', { payload: { designId, ai } });
}

export function enqueueDesignRepair(designId: string): string {
  return enqueue('design_repair', { payload: { designId } });
}

export function enqueueDesignExport(designId: string, format: ExportFormat, opts: { scale?: number; quality?: number } = {}): string {
  return enqueue('design_export', { payload: { designId, format, ...opts } });
}

/* ---------------- handlers ---------------- */

export function registerDesignJobs(): void {
  registerHandler('design_generate', async (job, ctx) => {
    const payload = readPayload<GenerationOptions & { designId?: string }>(job);
    if (!payload.designId) throw new Error('design_generate payload missing designId');
    const row = getDesignRow(payload.designId);
    if (!row) throw new Error(`design ${payload.designId} not found`);
    const brief = (payload.brief ?? row.brief ?? row.name).trim();
    if (!brief) throw new Error('a brief (or design name) is required to generate a design');
    const W = clampDim(payload.width ?? row.width);
    const H = clampDim(payload.height ?? row.height);

    const genId = startGeneration(row.id, 'generate', brief, payload);
    q.run("UPDATE design_documents SET status = 'generating', job_id = ?, error = NULL, updated_at = datetime('now') WHERE id = ?", job.id, row.id);
    ctx.report(4);
    try {
      const plan = await buildPlan(payload, row.id, brief, W, H, ctx);
      await finalizeDesign(row.id, plan.doc, plan.warnings, ctx);
      finishGeneration(genId, 'done', { warnings: plan.warnings, strategy: plan.direction.composition, source: plan.direction.background });
      logger.info('DESIGN', `design_generate done: ${row.id} (${plan.direction.composition})`);
    } catch (err) {
      const msg = String((err as Error).message).slice(0, 400);
      setDesignStatus(row.id, 'failed', msg);
      finishGeneration(genId, 'failed', undefined, msg);
      throw err;
    }
  });

  registerHandler('design_variants', async (job, ctx) => {
    const payload = readPayload<{ designId?: string; count?: number }>(job);
    if (!payload.designId) throw new Error('design_variants payload missing designId');
    const { row, doc } = getDesign(payload.designId);
    const brief = (row.brief ?? doc.metadata.brief ?? row.name).trim();
    const count = Math.max(1, Math.min(6, payload.count ?? 3));
    const W = row.width;
    const H = row.height;

    const genId = startGeneration(row.id, 'variants', brief, { count });
    ctx.report(5);
    const analysis = await analyzeBrief(brief, `${W}x${H}`, '');
    ctx.report(20);
    const base = fallbackArtDirection(brief, W, H, doc.metadata.palette ?? []);
    if (doc.metadata.strategy && STRATEGY_ROTATION.includes(doc.metadata.strategy as Composition)) {
      base.composition = doc.metadata.strategy as Composition;
    }
    const directions = await variantDirections(base, analysis, W, H, count);
    ctx.report(35);
    const blocks = await planCopy(brief, analysis, directions[0], DEFAULT_ROLES);

    const created: string[] = [];
    try {
      for (let i = 0; i < directions.length; i++) {
        const variantRow = createDesign({
          name: `${row.name} · v${i + 2}`,
          width: W,
          height: H,
          brief,
          category: row.category ?? undefined,
          tags: row.tags ?? undefined,
          status: 'generating',
        });
        try {
          const { doc: built, warnings } = buildLayout({ id: variantRow.id, canvas: { width: W, height: H }, direction: directions[i], blocks });
          built.metadata.brief = brief;
          built.metadata.generation = {
            artDirection: JSON.stringify({ concept: directions[i].concept }).slice(0, 4000),
            generatedAt: new Date().toISOString(),
            variantOf: row.id,
          };
          await finalizeDesign(variantRow.id, built, warnings, { report: (p) => ctx.report(Math.min(95, 35 + Math.round(((i + p / 100) / directions.length) * 60))) });
          created.push(variantRow.id);
        } catch (err) {
          setDesignStatus(variantRow.id, 'failed', String((err as Error).message).slice(0, 300));
          throw err;
        }
      }
      finishGeneration(genId, 'done', { designIds: created });
      logger.info('DESIGN', `design_variants done: ${row.id} -> ${created.join(', ')}`);
    } catch (err) {
      finishGeneration(genId, 'failed', { designIds: created }, String((err as Error).message).slice(0, 400));
      throw err;
    }
  });

  registerHandler('design_review', async (job, ctx) => {
    const payload = readPayload<{ designId?: string; ai?: boolean }>(job);
    if (!payload.designId) throw new Error('design_review payload missing designId');
    const { row, doc } = getDesign(payload.designId);
    ctx.report(10);
    const deterministic = reviewDesignDeterministic(doc, reviewContext());
    saveReview(row.id, row.revision, 'deterministic', deterministic.score, deterministic);
    ctx.report(40);

    let aiReview: Awaited<ReturnType<typeof reviewDesignAi>> | null = null;
    if (payload.ai && getSettings('design').review.ai) {
      const image = await renderSmallPng(doc);
      aiReview = await reviewDesignAi(doc, image, { ...reviewContext(), brief: doc.metadata.brief });
      saveReview(row.id, row.revision, 'ai', aiReview.score, aiReview);
    }
    ctx.report(95);
    logger.info('DESIGN', `design_review done: ${row.id} score ${aiReview?.score ?? deterministic.score}`);
  });

  registerHandler('design_repair', async (job, ctx) => {
    const payload = readPayload<{ designId?: string }>(job);
    if (!payload.designId) throw new Error('design_repair payload missing designId');
    const { row, doc } = getDesign(payload.designId);
    ctx.report(15);
    const result = deterministicRepair(doc);
    if (!result.applied.length) {
      logger.info('DESIGN', `design_repair: nothing to fix in ${row.id}`);
      ctx.report(95);
      return;
    }
    const saved = saveDesign(row.id, result.doc, { label: 'auto (before repair)' });
    saveReview(row.id, saved.row.revision, 'deterministic', null, { repaired: result.applied, rejected: result.rejected });
    ctx.report(95);
    logger.info('DESIGN', `design_repair applied ${result.applied.length} fix(es) to ${row.id}`);
  });

  registerHandler('design_export', async (job, ctx) => {
    const payload = readPayload<{ designId?: string; format?: string; scale?: number; quality?: number }>(job);
    if (!payload.designId) throw new Error('design_export payload missing designId');
    const format = EXPORT_FORMATS.includes(payload.format as ExportFormat) ? (payload.format as ExportFormat) : 'png';
    const { doc } = getDesign(payload.designId);
    ctx.report(15);
    const result = await exportDesign(doc, {
      format,
      scale: payload.scale ?? doc.settings.export.scale,
      quality: payload.quality ?? doc.settings.export.quality,
      resolveAssetFile,
      resolveFontFile: (family) => resolveFont(family) ?? null,
    });
    ctx.report(95);
    logger.info('DESIGN', `design_export done: ${result.fileName} (${result.bytes}B)`);
  });

  // Registered so the lane reports a truthful error instead of an unknown-type crash.
  registerHandler('social_batch', async () => {
    throw new Error('social_batch requires a connected social platform and is not implemented yet');
  });
  registerHandler('campaign_generate', async () => {
    throw new Error('campaign_generate is not implemented yet');
  });
}

/** Small raster of a document for vision AI (undefined when rendering is unavailable). */
async function renderSmallPng(doc: DesignDocument): Promise<VisionImage | undefined> {
  try {
    const svg = renderDocumentSvg(doc, {
      mode: 'embed',
      assetHref: (a) => {
        const f = resolveAssetFile(a.assetId);
        return f ? `data:${f.mime};base64,${fs.readFileSync(f.filePath).toString('base64')}` : null;
      },
    });
    const ratio = doc.canvas.width / doc.canvas.height;
    const w = ratio >= 1 ? 512 : Math.round(512 * ratio);
    const h = ratio >= 1 ? Math.round(512 / ratio) : 512;
    const out = path.join(config.dirs.temp, `design-review-${doc.id}-${doc.revision}-${Date.now()}.png`);
    try {
      await rasterizeSvgToImage(svg, out, Math.max(64, w), Math.max(64, h), 'png');
      return { data: fs.readFileSync(out).toString('base64'), mime: 'image/png' };
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* temp */ }
    }
  } catch (err) {
    logger.warn('DESIGN', `vision raster for review failed: ${String((err as Error).message).slice(0, 160)}`);
    return undefined;
  }
}

function readPayload<T>(job: JobRow): T {
  return job.payload ? (JSON.parse(job.payload) as T) : ({} as T);
}

function clampDim(n: number): number {
  if (!Number.isFinite(n)) return 1080;
  return Math.max(16, Math.min(10000, Math.round(n)));
}
