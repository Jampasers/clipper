import { z } from 'zod';
import { generateVision, type VisionImage } from '../lib/ai.js';
import { logger } from '../lib/log.js';
import { contrastRatio } from './color.js';
import { isProtectedTextLayer, type DesignDocument, type DesignLayer, type TextLayer } from './document.js';
import { resolveTextLayout, isKnownFont } from './typography.js';

/**
 * Design quality review: deterministic checks (always available) plus an
 * optional AI visual evaluation. Repairs are whitelisted, schema-validated and
 * bounded; they never rewrite text content, so prices, dates, contact details
 * and legal text cannot be silently altered.
 */

export const ISSUE_TYPES = ['bounds', 'overflow', 'missing_asset', 'collision', 'contrast', 'font', 'resolution', 'canvas', 'hierarchy', 'balance', 'readability', 'density', 'brief', 'other'] as const;

export const reviewIssueSchema = z.object({
  type: z.enum(ISSUE_TYPES),
  severity: z.enum(['low', 'medium', 'high']),
  layerId: z.string().max(64).optional(),
  description: z.string().min(1).max(600),
  suggestion: z.string().max(600).default(''),
});
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;

export interface DesignReview {
  source: 'deterministic' | 'ai';
  score: number;
  issues: ReviewIssue[];
  checks: Record<string, number | boolean>;
}

export interface ReviewContext {
  /** library asset -> intrinsic size (null when missing) */
  assetInfo?: (libraryAssetId: string) => { width: number | null; height: number | null } | null;
  customFonts?: string[];
  brief?: string;
}

export function reviewDesignDeterministic(doc: DesignDocument, ctx: ReviewContext = {}): DesignReview {
  const issues: ReviewIssue[] = [];
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const checks: Record<string, number | boolean> = {};

  if (W < 16 || H < 16 || W > 10000 || H > 10000) {
    issues.push({ type: 'canvas', severity: 'high', description: `canvas ${W}x${H} is outside supported dimensions`, suggestion: 'use a canvas between 16 and 10000 px' });
  }

  const childIds = new Set<string>();
  for (const l of doc.layers) if (l.type === 'group') for (const c of l.children) childIds.add(c);

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    // bounds
    const fullyOutside = layer.x + layer.width <= 0 || layer.y + layer.height <= 0 || layer.x >= W || layer.y >= H;
    const partiallyOutside = layer.x < -2 || layer.y < -2 || layer.x + layer.width > W + 2 || layer.y + layer.height > H + 2;
    if (fullyOutside) {
      issues.push({ type: 'bounds', severity: 'high', layerId: layer.id, description: `layer "${layer.name ?? layer.id}" is entirely outside the canvas`, suggestion: 'move it back inside the canvas or hide it' });
    } else if (partiallyOutside) {
      issues.push({ type: 'bounds', severity: 'medium', layerId: layer.id, description: `layer "${layer.name ?? layer.id}" extends outside the canvas`, suggestion: 'align it to the safe area' });
    }

    if (layer.type === 'text') {
      const { metrics } = resolveTextLayout(layer);
      if (metrics.height > layer.height + 1 || metrics.width > layer.width + 1) {
        issues.push({
          type: 'overflow', severity: 'high', layerId: layer.id,
          description: `text "${truncate(layer.text, 40)}" overflows its box (${Math.round(metrics.width)}x${Math.round(metrics.height)} > ${Math.round(layer.width)}x${Math.round(layer.height)})`,
          suggestion: 'reduce the font size, enlarge the text box or shorten the copy',
        });
      }
      if (!isKnownFont(layer.style.fontFamily, ctx.customFonts ?? [])) {
        issues.push({ type: 'font', severity: 'medium', layerId: layer.id, description: `font "${layer.style.fontFamily}" is not a known system font or uploaded font`, suggestion: 'pick a system font or upload the font to the asset library' });
      }
      const bg = doc.canvas.background.mode === 'color' ? doc.canvas.background.color ?? '#000000' : '#3a3a3a';
      const ratio = contrastRatio(layer.style.color, bg);
      if (ratio < 3 && layer.style.color.toLowerCase() !== bg.toLowerCase()) {
        issues.push({ type: 'contrast', severity: ratio < 2 ? 'high' : 'medium', layerId: layer.id, description: `text contrast ${ratio.toFixed(1)}:1 against the canvas background`, suggestion: 'increase text/background contrast (WCAG recommends 4.5:1)' });
      }
    }

    if (layer.type === 'image') {
      const docAsset = doc.assets.find((a) => a.id === layer.assetRef);
      if (!docAsset) {
        issues.push({ type: 'missing_asset', severity: 'high', layerId: layer.id, description: `image layer references unknown document asset "${layer.assetRef}"`, suggestion: 'replace the image' });
      } else {
        const info = ctx.assetInfo?.(docAsset.assetId);
        if (ctx.assetInfo && !info) {
          issues.push({ type: 'missing_asset', severity: 'high', layerId: layer.id, description: `library asset "${docAsset.name ?? docAsset.assetId}" is missing or disabled`, suggestion: 're-upload the image or replace it' });
        } else if (info?.width && layer.width > 0 && info.width < layer.width * 0.7) {
          issues.push({ type: 'resolution', severity: 'medium', layerId: layer.id, description: `image is ${info.width}px wide but displayed at ${Math.round(layer.width)}px`, suggestion: 'use a higher resolution source image' });
        }
        // image assets referenced by the layer must exist in the doc assets (schema already enforces)
      }
    }
  }

  // text collisions (axis-aligned approximation; ignore rotated layers)
  const texts = doc.layers.filter((l): l is TextLayer => l.type === 'text' && l.visible && !l.rotation);
  checks.text_layers = texts.length;
  let collisions = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      const overlapW = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapH = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const overlap = overlapW * overlapH;
      const smaller = Math.min(a.width * a.height, b.width * b.height);
      if (smaller > 0 && overlap / smaller > 0.15) {
        collisions++;
        issues.push({
          type: 'collision', severity: overlap / smaller > 0.4 ? 'high' : 'medium', layerId: b.id,
          description: `text layers "${a.name ?? a.id}" and "${b.name ?? b.id}" overlap by ${Math.round((overlap / smaller) * 100)}%`,
          suggestion: 'separate the text boxes or reduce their size',
        });
      }
    }
  }
  checks.collisions = collisions;

  // unreferenced doc assets are a smell, not an error
  const usedAssets = new Set(doc.layers.filter((l) => l.type === 'image').map((l) => (l.type === 'image' ? l.assetRef : '')));
  if (doc.canvas.background.assetRef) usedAssets.add(doc.canvas.background.assetRef);
  checks.unused_assets = doc.assets.filter((a) => !usedAssets.has(a.id)).length;
  for (const a of doc.assets.filter((x) => !usedAssets.has(x.id))) {
    issues.push({ type: 'other', severity: 'low', description: `asset "${a.name ?? a.assetId}" is embedded but unused`, suggestion: 'remove it to keep the document lean' });
  }

  const penalty = issues.reduce((sum, i) => sum + (i.severity === 'high' ? 20 : i.severity === 'medium' ? 8 : 3), 0);
  const score = Math.max(5, Math.min(100, 100 - penalty));
  checks.child_layers = childIds.size;
  return { source: 'deterministic', score, issues, checks };
}

/* ---------------- AI-assisted review ---------------- */

export const aiReviewSchema = z.object({
  score: z.number().min(0).max(100),
  hierarchy: z.enum(['weak', 'ok', 'strong']).default('ok'),
  balance: z.enum(['weak', 'ok', 'strong']).default('ok'),
  readability: z.enum(['weak', 'ok', 'strong']).default('ok'),
  brief_compliance: z.enum(['partial', 'ok', 'strong']).default('ok'),
  issues: z.array(reviewIssueSchema.partial().extend({ type: z.string().max(40), severity: z.enum(['low', 'medium', 'high']), description: z.string().min(1).max(600) })).max(20).default([]),
});

export function designSummary(doc: DesignDocument): string {
  const texts = doc.layers.filter((l): l is TextLayer => l.type === 'text').map((l) => `${l.id} (${l.style.fontSize}px): ${truncate(l.text, 100)}`);
  return [
    `canvas ${doc.canvas.width}x${doc.canvas.height}`,
    `title: ${doc.metadata.title}`,
    doc.metadata.brief ? `brief: ${truncate(doc.metadata.brief, 1000)}` : '',
    `layers: ${doc.layers.length} (${doc.layers.map((l) => l.type).join(', ')})`,
    `text:\n${texts.join('\n')}`,
  ].filter(Boolean).join('\n');
}

export async function reviewDesignAi(doc: DesignDocument, image?: VisionImage, ctx: ReviewContext = {}): Promise<DesignReview> {
  const deterministic = reviewDesignDeterministic(doc, ctx);
  try {
    if (!image) throw new Error('no rendered preview supplied');
    const geometry = doc.layers
      .slice(0, 80)
      .map((l) => `${l.id} | ${l.type} | ${Math.round(l.x)},${Math.round(l.y)},${Math.round(l.width)},${Math.round(l.height)} | ${l.type === 'text' ? truncate((l as TextLayer).text, 40) : ''}`)
      .join('\n');
    const res = await generateVision<unknown>('design_quality_review', { summary: designSummary(doc), geometry }, [image]);
    const parsed = aiReviewSchema.parse(res.json);
    const layerIds = new Set(doc.layers.map((l) => l.id));
    const aiIssues: ReviewIssue[] = parsed.issues.map((i) => ({
      type: (ISSUE_TYPES as readonly string[]).includes(i.type) ? (i.type as ReviewIssue['type']) : 'other',
      severity: i.severity,
      layerId: i.layerId && layerIds.has(i.layerId) ? i.layerId : undefined,
      description: i.description,
      suggestion: i.suggestion ?? '',
    }));
    return {
      source: 'ai',
      score: Math.round(parsed.score),
      issues: [...deterministic.issues, ...aiIssues],
      checks: { ...deterministic.checks, ai_hierarchy: parsed.hierarchy === 'strong' ? 1 : parsed.hierarchy === 'ok' ? 0.6 : 0.3, ai_balance: parsed.balance === 'strong' ? 1 : parsed.balance === 'ok' ? 0.6 : 0.3, ai_readability: parsed.readability === 'strong' ? 1 : parsed.readability === 'ok' ? 0.6 : 0.3 },
    };
  } catch (err: any) {
    logger.warn('DESIGN', `AI review unavailable, deterministic only: ${String(err?.message).slice(0, 200)}`);
    return deterministic;
  }
}

/* ---------------- bounded repair ---------------- */

export const repairOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move_layer'), layer_id: z.string().max(64), x: z.number().finite(), y: z.number().finite() }),
  z.object({ op: z.literal('resize_layer'), layer_id: z.string().max(64), width: z.number().finite(), height: z.number().finite() }),
  z.object({ op: z.literal('set_font_size'), layer_id: z.string().max(64), font_size: z.number().finite() }),
  z.object({ op: z.literal('set_color'), layer_id: z.string().max(64), color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/) }),
  z.object({ op: z.literal('set_opacity'), layer_id: z.string().max(64), opacity: z.number().min(0).max(1) }),
  z.object({ op: z.literal('set_alignment'), layer_id: z.string().max(64), alignment: z.enum(['left', 'center', 'right']) }),
  z.object({ op: z.literal('nudge_layer'), layer_id: z.string().max(64), dx: z.number().finite(), dy: z.number().finite() }),
]);
export type RepairOp = z.infer<typeof repairOpSchema>;

export interface RepairResult {
  doc: DesignDocument;
  applied: RepairOp[];
  rejected: { op: unknown; reason: string }[];
}

const MAX_REPAIRS = 20;

export function applyRepairs(doc: DesignDocument, rawOps: unknown): RepairResult {
  const applied: RepairOp[] = [];
  const rejected: { op: unknown; reason: string }[] = [];
  const next: DesignDocument = JSON.parse(JSON.stringify(doc));
  const ops = Array.isArray(rawOps) ? rawOps.slice(0, MAX_REPAIRS) : [];
  for (const raw of ops) {
    const parsed = repairOpSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ op: raw, reason: parsed.error.issues[0]?.message ?? 'invalid operation' });
      continue;
    }
    const op = parsed.data;
    const layer = next.layers.find((l) => l.id === op.layer_id);
    if (!layer) {
      rejected.push({ op, reason: `unknown layer id "${op.layer_id}"` });
      continue;
    }
    if (op.op === 'set_alignment' && layer.type !== 'text') {
      rejected.push({ op, reason: 'alignment only applies to text layers' });
      continue;
    }
    if ((op.op === 'set_font_size' || op.op === 'set_alignment') && isProtectedTextLayer(layer)) {
      rejected.push({ op, reason: 'protected business text is never restyled by automatic repair' });
      continue;
    }
    switch (op.op) {
      case 'move_layer':
        layer.x = clamp(op.x, -layer.width, next.canvas.width);
        layer.y = clamp(op.y, -layer.height, next.canvas.height);
        break;
      case 'nudge_layer':
        layer.x = clamp(layer.x + clamp(op.dx, -next.canvas.width, next.canvas.width), -layer.width, next.canvas.width);
        layer.y = clamp(layer.y + clamp(op.dy, -next.canvas.height, next.canvas.height), -layer.height, next.canvas.height);
        break;
      case 'resize_layer':
        layer.width = clamp(op.width, 4, next.canvas.width * 2);
        layer.height = clamp(op.height, 4, next.canvas.height * 2);
        break;
      case 'set_font_size':
        if (layer.type === 'text') layer.style.fontSize = clamp(op.font_size, 1, 2000);
        else {
          rejected.push({ op, reason: 'font size only applies to text layers' });
          continue;
        }
        break;
      case 'set_color':
        if (layer.type === 'text') layer.style.color = op.color;
        else if (layer.type === 'shape') layer.fill = op.color;
        else {
          rejected.push({ op, reason: 'color only applies to text/shape layers' });
          continue;
        }
        break;
      case 'set_opacity':
        layer.opacity = clamp(op.opacity, 0, 1);
        break;
      case 'set_alignment':
        if (layer.type === 'text') layer.style.align = op.alignment;
        break;
    }
    applied.push(op);
  }
  return { doc: next, applied, rejected };
}

/**
 * Deterministic repair for the issues that can be fixed safely:
 * pull layers back inside the canvas and shrink overflowing text.
 */
export function deterministicRepair(doc: DesignDocument): RepairResult {
  const next: DesignDocument = JSON.parse(JSON.stringify(doc));
  const applied: RepairOp[] = [];
  for (const layer of next.layers) {
    if (!layer.visible) continue;
    const nx = clamp(layer.x, 0, Math.max(0, next.canvas.width - Math.min(layer.width, next.canvas.width)));
    const ny = clamp(layer.y, 0, Math.max(0, next.canvas.height - Math.min(layer.height, next.canvas.height)));
    if (nx !== layer.x || ny !== layer.y) {
      layer.x = nx;
      layer.y = ny;
      applied.push({ op: 'move_layer', layer_id: layer.id, x: nx, y: ny });
    }
    if (layer.type === 'text' && layer.style.overflow !== 'shrink') {
      const { metrics } = resolveTextLayout(layer);
      if (metrics.height > layer.height + 1) {
        const size = Math.max(8, Math.floor((layer.style.fontSize * layer.height) / metrics.height));
        if (size < layer.style.fontSize) {
          layer.style.fontSize = size;
          applied.push({ op: 'set_font_size', layer_id: layer.id, font_size: size });
        }
      }
    }
  }
  return { doc: next, applied, rejected: [] };
}

function clamp(n: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)); }
function truncate(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}…` : s; }
