import { z } from 'zod';
import { hexColor, type DesignDocument, type DesignLayer, type ShapeLayer } from './document.js';
import { bestInk, contrastRatio, mix, withAlpha } from './color.js';
import { type FontSpec } from './typography.js';

/**
 * Deterministic layout engine.
 *
 * AI proposes an ArtDirection; this module decides the concrete, validated
 * placement of every layer. Compositions are strategies, not fixed templates —
 * block text, canvas size, palette and image slots all feed the geometry, so
 * two posters from the same strategy never come out identical.
 */

export const COMPOSITIONS = [
  'editorial', 'minimalist', 'modern_promo', 'bold_typography', 'product_showcase',
  'event_poster', 'corporate', 'luxury', 'social',
] as const;
export type Composition = (typeof COMPOSITIONS)[number];

export const artDirectionSchema = z.object({
  concept: z.string().max(200).default(''),
  rationale: z.string().max(1000).default(''),
  composition: z.enum(COMPOSITIONS).default('modern_promo'),
  hierarchy: z.array(z.enum(['headline', 'subheadline', 'image', 'cta', 'details'])).max(8).default(['headline', 'subheadline', 'cta', 'details']),
  palette: z.array(hexColor).min(1).max(8),
  typography: z
    .object({
      heading_family: z.string().max(120).default('Arial Black'),
      body_family: z.string().max(120).default('Segoe UI'),
      scale: z.number().min(0.5).max(3).default(1.2),
      heading_weight: z.number().int().min(100).max(900).default(800),
      uppercase_headline: z.boolean().default(true),
    })
    .default({}),
  texture: z.enum(['none', 'grain', 'paper', 'noise', 'pattern']).default('none'),
  background: z.enum(['solid', 'gradient', 'image']).default('solid'),
  image_prompt: z.string().max(1000).default(''),
  decorative_elements: z.array(z.string().max(60)).max(8).default([]),
  density: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type ArtDirection = z.infer<typeof artDirectionSchema>;

export const ROLES = ['headline', 'subheadline', 'body', 'cta', 'price', 'date', 'contact', 'details', 'tagline'] as const;
export type TextRole = (typeof ROLES)[number];

export interface ContentBlock {
  id: string;
  role: TextRole;
  text: string;
}

export interface ImageSlot {
  assetRef: string;
  role: 'hero' | 'background' | 'product';
}

export interface TextPlace {
  block: ContentBlock;
  x: number;
  y: number;
  width: number;
  height: number;
  align: 'left' | 'center' | 'right';
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  uppercase?: boolean;
  lineHeight?: number;
  /** text drawn over a raster scrim rather than the flat canvas background */
  overImage?: boolean;
}

export interface LayoutResult {
  textPlacements: TextPlace[];
  images: { assetRef: string; role: string; x: number; y: number; width: number; height: number; cornerRadius?: number }[];
  decorations: ShapeLayer[];
  warnings: string[];
}

interface Ctx {
  W: number;
  H: number;
  m: number;
  safe: { top: number; right: number; bottom: number; left: number };
  dir: ArtDirection;
  blocks: ContentBlock[];
  images: ImageSlot[];
  col: number;
}

function scaleFor(c: Ctx, base: number): number {
  return c.dir.typography.scale * base * c.W;
}

function byRole(c: Ctx, role: TextRole): ContentBlock | undefined {
  return c.blocks.find((b) => b.role === role && String(b.text ?? '').trim()) ?? undefined;
}

const TYPE_BY_ROLE: Record<TextRole, { base: number; family: 'heading' | 'body'; weight: number }> = {
  headline: { base: 0.1, family: 'heading', weight: 800 },
  subheadline: { base: 0.052, family: 'body', weight: 500 },
  body: { base: 0.032, family: 'body', weight: 400 },
  cta: { base: 0.038, family: 'heading', weight: 700 },
  price: { base: 0.07, family: 'heading', weight: 800 },
  date: { base: 0.045, family: 'heading', weight: 700 },
  contact: { base: 0.026, family: 'body', weight: 400 },
  details: { base: 0.028, family: 'body', weight: 400 },
  tagline: { base: 0.036, family: 'body', weight: 500 },
};

function makePlace(c: Ctx, block: ContentBlock, o: Partial<TextPlace> & { x: number; y: number; width: number; height: number }): TextPlace {
  const t = TYPE_BY_ROLE[block.role];
  return {
    block,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    align: o.align ?? 'left',
    fontSize: o.fontSize ?? scaleFor(c, t.base),
    fontFamily: o.fontFamily ?? (t.family === 'heading' ? c.dir.typography.heading_family : c.dir.typography.body_family),
    fontWeight: o.fontWeight ?? t.weight,
    uppercase: o.uppercase ?? (block.role === 'headline' ? c.dir.typography.uppercase_headline : false),
    lineHeight: o.lineHeight,
    overImage: o.overImage,
  };
}

function shape(id: string, o: Partial<ShapeLayer> & { x: number; y: number; width: number; height: number }): ShapeLayer {
  return {
    id, type: 'shape', shape: o.shape ?? 'rect', fill: o.fill ?? '#ffffff', opacity: o.opacity ?? 1,
    x: o.x, y: o.y, width: o.width, height: o.height, rotation: 0, visible: o.visible ?? true, locked: o.locked ?? false,
    cornerRadius: o.cornerRadius ?? 0, stroke: o.stroke, shadow: o.shadow, name: o.name,
  };
}

type Strategy = (c: Ctx) => LayoutResult;

/* ---------------- strategies ---------------- */

const editorial: Strategy = (c) => {
  const contentW = c.images.length ? c.W * 0.46 : c.col;
  const placements: TextPlace[] = [];
  let y = c.safe.top + c.m;
  const headline = byRole(c, 'headline');
  if (headline) {
    const h = c.H * 0.24;
    placements.push(makePlace(c, headline, { x: c.m, y, width: contentW, height: h, align: 'left', lineHeight: 1.06 }));
    y += h + c.m * 0.3;
  }
  const sub = byRole(c, 'subheadline');
  if (sub) {
    const h = c.H * 0.09;
    placements.push(makePlace(c, sub, { x: c.m, y, width: contentW, height: h, align: 'left' }));
    y += h + c.m * 0.3;
  }
  const decorations: ShapeLayer[] = [
    shape('rule', { x: c.m, y, width: c.W * 0.14, height: Math.max(2, c.W * 0.005) }),
  ];
  y += c.m * 0.6;
  const body = byRole(c, 'body');
  if (body) placements.push(makePlace(c, body, { x: c.m, y, width: Math.min(contentW, c.W * 0.42), height: c.H * 0.26, align: 'left', lineHeight: 1.4 }));
  const bottomRoles: TextRole[] = ['price', 'date', 'contact', 'details', 'tagline'];
  const bottom = c.blocks.filter((b) => bottomRoles.includes(b.role)).slice(0, 3);
  let by = c.H - c.safe.bottom - c.m;
  for (const b of bottom.reverse()) {
    by -= c.W * 0.045;
    placements.push(makePlace(c, b, { x: c.m, y: by, width: contentW, height: c.W * 0.04, align: 'left' }));
  }
  return {
    textPlacements: placements,
    images: c.images.length ? [{ assetRef: c.images[0].assetRef, role: c.images[0].role, x: c.W * 0.54, y: c.safe.top + c.m, width: c.W * 0.4, height: c.H - c.m * 2 - c.safe.top - c.safe.bottom, cornerRadius: Math.max(4, c.W * 0.01) }] : [],
    decorations,
    warnings: [],
  };
};

const minimalist: Strategy = (c) => {
  const placements: TextPlace[] = [];
  let y = c.H * 0.3;
  const headline = byRole(c, 'headline');
  if (headline) {
    const h = c.H * 0.17;
    placements.push(makePlace(c, headline, { x: c.m, y, width: c.col, height: h, align: 'center', fontSize: scaleFor(c, 0.07), lineHeight: 1.2 }));
    y += h + c.m * 0.6;
  }
  const sub = byRole(c, 'subheadline');
  if (sub) {
    placements.push(makePlace(c, sub, { x: c.m, y, width: c.col, height: c.W * 0.08, align: 'center' }));
    y += c.W * 0.1;
  }
  const ctaB = byRole(c, 'cta');
  if (ctaB) placements.push(makePlace(c, ctaB, { x: c.col * 0.33, y: y + c.m * 0.2, width: c.col * 0.34, height: c.W * 0.06, align: 'center' }));
  const details = c.blocks.filter((b) => ['price', 'date', 'contact', 'details', 'tagline'].includes(b.role)).slice(0, 3);
  let dy = c.H - c.safe.bottom - c.m - details.length * c.W * 0.042;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.038, align: 'center' }));
    dy += c.W * 0.045;
  }
  return { textPlacements: placements, images: [], decorations: [], warnings: [] };
};

const modernPromo: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const hero = c.images.find((i) => i.role === 'hero' || i.role === 'product');
  const imgH = hero ? c.H * 0.46 : 0;
  let y = c.safe.top + c.m + (hero ? 0 : c.H * 0.06);
  const headline = byRole(c, 'headline');
  if (headline) {
    const h = c.H * 0.19;
    placements.push(makePlace(c, headline, { x: c.m, y: Math.max(y, imgH + c.m * 0.5), width: c.col, height: h, align: 'left', lineHeight: 1.02 }));
    y = Math.max(y, imgH + c.m * 0.5) + h;
  }
  const sub = byRole(c, 'subheadline');
  if (sub) placements.push(makePlace(c, sub, { x: c.m, y: y + c.m * 0.3, width: c.col * 0.8, height: c.H * 0.08, align: 'left' }));
  const ctaB = byRole(c, 'cta');
  const ctaY = c.H - c.safe.bottom - c.m - c.W * 0.12;
  if (ctaB) placements.push(makePlace(c, ctaB, { x: c.m, y: ctaY, width: c.col * 0.55, height: c.W * 0.12, align: 'left' }));
  const priceB = byRole(c, 'price');
  if (priceB) placements.push(makePlace(c, priceB, { x: c.W * 0.6, y: c.safe.top + c.m * 0.3, width: c.W * 0.34, height: c.W * 0.12, align: 'right' }));
  const detailRoles: TextRole[] = ['date', 'contact', 'details', 'body', 'tagline'];
  const details = c.blocks.filter((b) => detailRoles.includes(b.role)).slice(0, 2);
  const pillFs = ctaB ? scaleFor(c, TYPE_BY_ROLE.cta.base) : 0;
  const firstFs = scaleFor(c, TYPE_BY_ROLE[details[0]?.role ?? 'details'].base);
  let dy = ctaY - pillFs * 0.25 - firstFs * 1.2 - c.W * 0.01;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.04, align: 'left' }));
    dy -= c.W * 0.05;
  }
  return {
    textPlacements: placements,
    images: hero ? [{ assetRef: hero.assetRef, role: hero.role, x: 0, y: 0, width: c.W, height: imgH }] : [],
    decorations: [],
    warnings: [],
  };
};

const boldTypography: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const headline = byRole(c, 'headline');
  if (headline) {
    const longest = Math.max(...headline.text.split(/\s+/).map((w) => w.length), 1);
    const fitFs = Math.min(scaleFor(c, 0.24), (c.col / (longest * 0.62)) * 1.6);
    placements.push(makePlace(c, headline, { x: c.m, y: c.H * 0.16, width: c.col, height: c.H * 0.46, align: 'center', fontSize: fitFs, lineHeight: 0.98 }));
  }
  const sub = byRole(c, 'subheadline');
  if (sub) placements.push(makePlace(c, sub, { x: c.m, y: c.H * 0.1, width: c.col, height: c.H * 0.06, align: 'center' }));
  const ctaB = byRole(c, 'cta');
  if (ctaB) placements.push(makePlace(c, ctaB, { x: c.col * 0.25, y: c.H * 0.76, width: c.col * 0.5, height: c.W * 0.1, align: 'center' }));
  const details = c.blocks.filter((b) => ['price', 'date', 'contact', 'details', 'tagline'].includes(b.role)).slice(0, 3);
  let dy = c.H - c.safe.bottom - c.m - details.length * c.W * 0.04;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.036, align: 'center' }));
    dy += c.W * 0.042;
  }
  return { textPlacements: placements, images: [], decorations: [], warnings: [] };
};

const productShowcase: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const hero = c.images.find((i) => i.role === 'product' || i.role === 'hero') ?? c.images[0];
  const imgH = hero ? c.H * 0.52 : 0;
  const headline = byRole(c, 'headline');
  if (headline) placements.push(makePlace(c, headline, { x: c.m, y: imgH + c.m, width: c.col, height: c.H * 0.13, align: 'center', lineHeight: 1.05 }));
  const sub = byRole(c, 'subheadline');
  if (sub) placements.push(makePlace(c, sub, { x: c.m, y: imgH + c.m + c.H * 0.14, width: c.col, height: c.H * 0.06, align: 'center' }));
  const priceB = byRole(c, 'price');
  if (priceB) placements.push(makePlace(c, priceB, { x: c.m, y: imgH + c.m + c.H * 0.2, width: c.col * 0.5, height: c.W * 0.09, align: 'center' }));
  const ctaY = c.H - c.safe.bottom - c.m - c.W * 0.11;
  const ctaB = byRole(c, 'cta');
  if (ctaB) placements.push(makePlace(c, ctaB, { x: c.m, y: ctaY, width: c.col, height: c.W * 0.11, align: 'center' }));
  const details = c.blocks.filter((b) => ['date', 'contact', 'body', 'tagline', 'details'].includes(b.role)).slice(0, 2);
  let dy = c.H - c.safe.bottom - c.m - c.W * 0.16 - details.length * c.W * 0.042;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.038, align: 'center' }));
    dy += c.W * 0.045;
  }
  return {
    textPlacements: placements,
    images: hero ? [{ assetRef: hero.assetRef, role: hero.role, x: 0, y: 0, width: c.W, height: imgH }] : [],
    decorations: [],
    warnings: hero ? [] : ['product showcase without a product image'],
  };
};

const eventPoster: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const headline = byRole(c, 'headline');
  if (headline) placements.push(makePlace(c, headline, { x: c.m, y: c.H * 0.16, width: c.col, height: c.H * 0.24, align: 'center', lineHeight: 1.0 }));
  const dateB = byRole(c, 'date');
  if (dateB) placements.push(makePlace(c, dateB, { x: c.m, y: c.H * 0.44, width: c.col, height: c.W * 0.09, align: 'center', uppercase: true }));
  const sub = byRole(c, 'subheadline');
  if (sub) placements.push(makePlace(c, sub, { x: c.m, y: c.H * 0.55, width: c.col, height: c.H * 0.07, align: 'center' }));
  const barH = Math.max(3, c.W * 0.008);
  const decorations: ShapeLayer[] = [
    shape('bar-top', { x: c.col * 0.32, y: c.H * 0.09, width: c.col * 0.36, height: barH, opacity: 0.7 }),
    shape('bar-bottom', { x: c.col * 0.32, y: c.H * 0.65, width: c.col * 0.36, height: barH, opacity: 0.7 }),
  ];
  const details = c.blocks.filter((b) => ['contact', 'details', 'price', 'body', 'tagline'].includes(b.role)).slice(0, 3);
  let dy = c.H - c.safe.bottom - c.m - details.length * c.W * 0.045;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.04, align: 'center' }));
    dy += c.W * 0.048;
  }
  return { textPlacements: placements, images: [], decorations, warnings: [] };
};

const corporate: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const headline = byRole(c, 'headline');
  if (headline) placements.push(makePlace(c, headline, { x: c.m, y: c.H * 0.26, width: c.col * 0.78, height: c.H * 0.15, align: 'left', lineHeight: 1.12 }));
  const sub = byRole(c, 'subheadline');
  if (sub) placements.push(makePlace(c, sub, { x: c.m, y: c.H * 0.43, width: c.col * 0.62, height: c.H * 0.07, align: 'left' }));
  const body = byRole(c, 'body');
  if (body) placements.push(makePlace(c, body, { x: c.m, y: c.H * 0.53, width: c.col * 0.55, height: c.H * 0.18, align: 'left', lineHeight: 1.45 }));
  const decorations: ShapeLayer[] = [
    shape('accent-bar', { x: c.m, y: c.H * 0.2, width: c.W * 0.12, height: Math.max(3, c.W * 0.007) }),
  ];
  const ctaB = byRole(c, 'cta');
  if (ctaB) placements.push(makePlace(c, ctaB, { x: c.col * 0.58, y: c.H - c.safe.bottom - c.m - c.W * 0.085, width: c.col * 0.42, height: c.W * 0.085, align: 'right' }));
  const details = c.blocks.filter((b) => ['price', 'date', 'contact', 'details', 'tagline'].includes(b.role)).slice(0, 2);
  let dy = c.H - c.safe.bottom - c.m - c.W * 0.12;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col * 0.55, height: c.W * 0.034, align: 'left' }));
    dy -= c.W * 0.042;
  }
  return { textPlacements: placements, images: [], decorations, warnings: [] };
};

const luxury: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const headline = byRole(c, 'headline');
  if (headline) placements.push(makePlace(c, headline, { x: c.m * 1.6, y: c.H * 0.3, width: c.col - c.m * 3.2, height: c.H * 0.15, align: 'center', lineHeight: 1.25, fontSize: scaleFor(c, 0.055) }));
  const tagline = byRole(c, 'tagline');
  if (tagline) placements.push(makePlace(c, tagline, { x: c.m * 1.6, y: c.H * 0.46, width: c.col - c.m * 3.2, height: c.W * 0.04, align: 'center', uppercase: true }));
  const lineW = c.W * 0.16;
  const decorations: ShapeLayer[] = [
    shape('gold-line', { x: (c.W - lineW) / 2, y: c.H * 0.435, width: lineW, height: Math.max(2, c.W * 0.005), opacity: 0.85 }),
  ];
  const details = c.blocks.filter((b) => ['price', 'date', 'contact', 'details', 'subheadline'].includes(b.role)).slice(0, 3);
  let dy = c.H - c.safe.bottom - c.m * 1.6 - details.length * c.W * 0.042;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.036, align: 'center' }));
    dy += c.W * 0.045;
  }
  return { textPlacements: placements, images: [], decorations, warnings: [] };
};

const social: Strategy = (c) => {
  const placements: TextPlace[] = [];
  const hero = c.images[0];
  const top = hero ? c.H * 0.28 + c.m : c.H * 0.3;
  const headline = byRole(c, 'headline');
  if (headline) placements.push(makePlace(c, headline, { x: c.m, y: top, width: c.col, height: c.H * 0.18, align: 'center', lineHeight: 1.05 }));
  const sub = byRole(c, 'subheadline');
  if (sub) placements.push(makePlace(c, sub, { x: c.m, y: top + c.H * 0.2, width: c.col, height: c.H * 0.07, align: 'center' }));
  const ctaB = byRole(c, 'cta');
  if (ctaB) placements.push(makePlace(c, ctaB, { x: c.col * 0.22, y: c.H - c.safe.bottom - c.m - c.W * 0.12, width: c.col * 0.56, height: c.W * 0.12, align: 'center' }));
  const details = c.blocks.filter((b) => ['price', 'date', 'contact', 'tagline', 'details'].includes(b.role)).slice(0, 2);
  let dy = c.H * 0.13;
  for (const b of details) {
    placements.push(makePlace(c, b, { x: c.m, y: dy, width: c.col, height: c.W * 0.04, align: 'center' }));
    dy += c.W * 0.045;
  }
  return {
    textPlacements: placements,
    images: hero ? [{ assetRef: hero.assetRef, role: hero.role, x: 0, y: 0, width: c.W, height: c.H * 0.26 }] : [],
    decorations: [],
    warnings: [],
  };
};

const STRATEGIES: Record<Composition, Strategy> = {
  editorial, minimalist, modern_promo: modernPromo, bold_typography: boldTypography,
  product_showcase: productShowcase, event_poster: eventPoster, corporate, luxury, social,
};

export const STRATEGY_ROTATION: Composition[] = ['modern_promo', 'bold_typography', 'editorial', 'event_poster', 'minimalist', 'product_showcase', 'social', 'corporate', 'luxury'];

/* ---------------- document builder ---------------- */

export interface BuildDocumentInput {
  id: string;
  canvas: { width: number; height: number; safeArea?: { top: number; right: number; bottom: number; left: number } };
  direction: ArtDirection;
  blocks: ContentBlock[];
  images?: ImageSlot[];
  /** >0 rotates the composition strategy for genuinely different variants */
  variant?: number;
}

export function buildLayout(input: BuildDocumentInput): { doc: DesignDocument; warnings: string[] } {
  const W = Math.max(16, Math.round(input.canvas.width));
  const H = Math.max(16, Math.round(input.canvas.height));
  const safe = {
    top: input.canvas.safeArea?.top ?? 0,
    right: input.canvas.safeArea?.right ?? 0,
    bottom: input.canvas.safeArea?.bottom ?? 0,
    left: input.canvas.safeArea?.left ?? 0,
  };
  const m = Math.min(200, Math.max(20, W * 0.065));
  const colWidth = W - m * 2;
  const baseDir = artDirectionSchema.parse(input.direction);
  const dir: ArtDirection = input.variant && input.variant > 0
    ? {
        ...baseDir,
        composition: STRATEGY_ROTATION[(STRATEGY_ROTATION.indexOf(baseDir.composition) + input.variant) % STRATEGY_ROTATION.length],
        // rotate hierarchy emphasis too so variants are not just relayouts
        typography: {
          ...baseDir.typography,
          scale: input.variant % 2 === 1 ? Math.min(1.8, baseDir.typography.scale * 1.12) : Math.max(0.9, baseDir.typography.scale * 0.92),
          uppercase_headline: input.variant % 2 === 1 ? true : baseDir.typography.uppercase_headline,
        },
      }
    : baseDir;

  const ctx: Ctx = { W, H, m, safe, dir, blocks: input.blocks.filter((b) => String(b.text ?? '').trim()), images: input.images ?? [], col: colWidth };
  const result = STRATEGIES[dir.composition](ctx);
  const warnings = [...result.warnings];

  const palette = dedupePalette(dir.palette);
  const bg = palette[0] ?? '#101322';
  const hasBgImage = dir.background === 'image' && ctx.images.length > 0;
  const ink = hasBgImage ? '#ffffff' : bestInk(bg);
  const accent = accentFor(palette, bg);

  const layers: DesignLayer[] = [];
  let seq = 0;
  const nid = (p: string) => `${p}-${++seq}`;

  if (dir.background === 'gradient' && palette.length >= 2) {
    layers.push(shape(nid('bg'), {
      name: 'Background gradient',
      x: 0, y: 0, width: W, height: H, cornerRadius: 0,
      fill: { type: 'linear', angle: 140, stops: [{ offset: 0, color: palette[0] }, { offset: 1, color: palette[palette.length - 1] }] },
    }));
  } else if (hasBgImage) {
    layers.push({
      id: nid('bgimg'), type: 'image', name: 'Background image',
      x: 0, y: 0, width: W, height: H, assetRef: ctx.images[0].assetRef, fit: 'cover',
      focusX: 0.5, focusY: 0.5, cornerRadius: 0, opacity: 1, visible: true, locked: false, rotation: 0,
    });
    layers.push(shape(nid('scrim'), {
      name: 'Readability scrim', x: 0, y: 0, width: W, height: H, cornerRadius: 0,
      fill: withAlpha(palette[0] ?? '#101322', 0.55),
    }));
  }

  for (const d of result.decorations) {
    layers.push({ ...d, id: nid('decor'), fill: d.fill === '#ffffff' ? accent : d.fill, name: d.name ?? 'Decoration' });
  }

  for (const img of result.images) {
    layers.push({
      id: nid('img'), type: 'image', name: `${img.role} image`,
      x: img.x, y: img.y, width: img.width, height: img.height, assetRef: img.assetRef, fit: 'cover',
      focusX: 0.5, focusY: 0.5, cornerRadius: img.cornerRadius ?? 0, opacity: 1, visible: true, locked: false, rotation: 0,
    });
  }

  for (const p of result.textPlacements) {
    const spec: FontSpec = {
      fontFamily: p.fontFamily, fontSize: p.fontSize, fontWeight: p.fontWeight,
      lineHeight: p.lineHeight ?? (p.block.role === 'body' ? 1.45 : 1.15), letterSpacing: 0, uppercase: p.uppercase,
    };
    const isCta = p.block.role === 'cta';
    const color = isCta ? bestInk(accent) : contrastRatio(ink, hasBgImage ? '#3a3a3a' : bg) >= 2.5 ? ink : bestInk(bg);
    layers.push({
      id: nid(p.block.id), type: 'text', name: p.block.id,
      x: clampNum(p.x, -W, W * 2), y: clampNum(p.y, -H, H * 2),
      width: Math.max(24, Math.min(p.width, W * 1.5)), height: Math.max(p.fontSize * 1.2, p.height),
      text: p.block.text,
      style: {
        fontFamily: p.fontFamily, fontSize: round(p.fontSize, 1), fontWeight: p.fontWeight,
        lineHeight: spec.lineHeight, letterSpacing: 0, align: p.align, color, uppercase: !!p.uppercase, overflow: 'shrink',
      },
      opacity: 1, visible: true, locked: false, rotation: 0,
    });
    if (isCta) {
      // CTA pill sits behind the CTA text
      layers.splice(layers.length - 1, 0, shape(nid('cta-pill'), {
        name: 'CTA pill', x: p.x - W * 0.015, y: p.y - p.fontSize * 0.25,
        width: p.width + W * 0.03, height: p.height + p.fontSize * 0.5,
        cornerRadius: Math.max(6, p.height * 0.5), fill: accent,
      }));
    }
  }

  const doc: DesignDocument = {
    id: input.id,
    schemaVersion: 1,
    revision: 1,
    canvas: { width: W, height: H, background: { mode: 'color', color: bg, blur: 0 }, safeArea: safe },
    metadata: {
      title: dir.concept || 'Generated design',
      tags: [],
      strategy: dir.composition,
      palette: [bg, ink, accent, ...palette].slice(0, 8),
    },
    assets: [],
    layers,
    settings: { export: { format: 'png', scale: 1, quality: 92 } },
  };

  return { doc, warnings };
}

function accentFor(palette: string[], bg: string): string {
  for (const cand of palette.slice(1)) {
    if (cand.toLowerCase() !== bg.toLowerCase() && contrastRatio(cand, '#ffffff') > 2.0 && contrastRatio(cand, '#111111') > 2.0) return cand;
  }
  return mix(bg, bestInk(bg), 0.35);
}

function dedupePalette(palette: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of palette) {
    const key = c.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

function clampNum(n: number, min: number, max: number): number { return Math.min(max, Math.max(min, n)); }
function round(n: number, digits: number): number { const f = 10 ** digits; return Math.round(n * f) / f; }
