import { z } from 'zod';
import { generate } from '../lib/ai.js';
import { logger } from '../lib/log.js';
import { hexColor } from './document.js';
import { artDirectionSchema, COMPOSITIONS, STRATEGY_ROTATION, type ArtDirection, type ContentBlock, type TextRole } from './layout.js';

/**
 * AI Art Director.
 *
 * Each step maps to one routed AI task with a zod-validated output schema and a
 * deterministic fallback, so design generation works without AI at all:
 *   1. creative_brief_analysis  → structured brief
 *   2. design_art_direction     → ArtDirection (never free-form HTML/CSS)
 *   3. design_copywriting       → short text blocks (facts only from the brief)
 *   4. design_asset_planning    → raster asset plan (optional)
 *   5. design_variants          → alternative directions
 * The model never emits code, paths or markup; every field is re-validated.
 */

export const briefAnalysisSchema = z.object({
  goal: z.string().max(400).default(''),
  audience: z.string().max(300).default('unspecified'),
  tone: z.string().max(200).default('professional'),
  must_include: z.array(z.string().max(300)).max(20).default([]),
  avoid: z.array(z.string().max(200)).max(10).default([]),
  cta: z.string().max(120).default(''),
  language: z.string().max(20).default('en'),
  format_intent: z.string().max(60).default('poster'),
});
export type BriefAnalysis = z.infer<typeof briefAnalysisSchema>;

export const copyPlanSchema = z.object({
  blocks: z.array(z.object({ id: z.string().max(64), text: z.string().max(600) })).max(20),
  notes: z.string().max(400).default(''),
});

export const assetPlanSchema = z.object({
  needs_background: z.boolean().default(false),
  needs_hero_image: z.boolean().default(false),
  background_prompt: z.string().max(1000).default(''),
  negative_prompt: z.string().max(500).default('text, watermark, logo, letters, numbers'),
  library_asset_ids: z.array(z.string().max(64)).max(10).default([]),
  notes: z.string().max(300).default(''),
});

const variantsSchema = z.object({
  variants: z
    .array(
      z.object({
        concept: z.string().max(200).default(''),
        composition: z.enum(COMPOSITIONS).default('modern_promo'),
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
        background: z.enum(['solid', 'gradient', 'image']).default('solid'),
        density: z.enum(['low', 'medium', 'high']).default('medium'),
        image_prompt: z.string().max(1000).default(''),
      })
    )
    .max(6),
});

const PROTECTED_FACT = /\d|[$€£¥]|@|(?:\+?\d[\d\s().-]{6,})|(?:www\.|https?:\/\/)/i;
const CTA_HINT = /\b(call|visit|order|book|register|join|subscribe|follow|download|shop|buy|hubungi|daftar|kunjungi|pesan|beli|ikuti|dapatkan)\b/i;

/* ---------------- deterministic fallbacks ---------------- */

const PALETTES: string[][] = [
  ['#0e1524', '#f4f6fb', '#6c8cff', '#a06bff', '#3ddc97'],
  ['#1a0f14', '#fff5f0', '#ff5c7a', '#ffbf47', '#ff8a5c'],
  ['#0d1a16', '#f2fbf7', '#3ddc97', '#25a884', '#d8ffe9'],
  ['#12100e', '#faf7f2', '#e0b354', '#b98a2f', '#f3e7cf'],
  ['#101322', '#ffffff', '#ff3d00', '#ffd400', '#8ab4ff'],
  ['#f7f5f1', '#1d1d1f', '#c94f2e', '#2e6f95', '#e8d9c5'],
  ['#0a0f1e', '#eaf0ff', '#5b8cff', '#00d4b8', '#ffd166'],
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function fallbackBriefAnalysis(brief: string): BriefAnalysis {
  const text = brief.trim();
  const facts = text
    .split(/[\n.;!?•]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && s.length <= 300 && PROTECTED_FACT.test(s))
    .slice(0, 6);
  const ctaMatch = text.split('\n').find((l) => CTA_HINT.test(l));
  return briefAnalysisSchema.parse({
    goal: text.split(/[\n.!?]/)[0]?.slice(0, 300) ?? '',
    tone: 'professional',
    must_include: facts,
    cta: ctaMatch?.trim().slice(0, 100) ?? '',
    language: /\b(dan|yang|dengan|untuk|gratis|diskon)\b/i.test(text) ? 'id' : 'en',
  });
}

export function fallbackArtDirection(brief: string, width: number, height: number, brandPalette: string[] = []): ArtDirection {
  const h = hashString(brief + width + 'x' + height);
  const composition = STRATEGY_ROTATION[h % STRATEGY_ROTATION.length];
  const palette = brandPalette.length >= 2 ? brandPalette.slice(0, 6) : PALETTES[h % PALETTES.length];
  const portrait = height >= width;
  return artDirectionSchema.parse({
    concept: fallbackBriefAnalysis(brief).goal.slice(0, 80) || 'Bold announcement',
    rationale: 'Deterministic fallback direction (AI unavailable)',
    composition,
    palette,
    typography: {
      heading_family: h % 2 ? 'Arial Black' : 'Impact',
      body_family: 'Segoe UI',
      scale: portrait ? 1.25 : 1.15,
      heading_weight: 800,
      uppercase_headline: true,
    },
    background: h % 3 === 0 ? 'gradient' : 'solid',
    density: 'medium',
    image_prompt: '',
  });
}

const ROLE_ORDER: TextRole[] = ['headline', 'subheadline', 'cta', 'price', 'date', 'contact', 'details', 'body', 'tagline'];
export const DEFAULT_ROLES: TextRole[] = ['headline', 'subheadline', 'cta', 'price', 'date', 'contact', 'details'];

export function fallbackCopy(brief: string, analysis: BriefAnalysis, roles: TextRole[]): ContentBlock[] {
  const lines = brief
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sentencePool = lines.length ? lines : brief.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const blocks: ContentBlock[] = [];
  const used = new Set<string>();

  const takeLine = (pred: (l: string) => boolean): string | undefined => {
    const found = sentencePool.find((l) => !used.has(l) && pred(l) && l.length <= 120);
    if (found) used.add(found);
    return found;
  };

  if (roles.includes('headline')) {
    const first = sentencePool.find((l) => !used.has(l) && l.length <= 90) ?? analysis.goal;
    if (first) {
      used.add(first);
      blocks.push({ id: 'headline', role: 'headline', text: first.replace(/[•\-–—:]+$/, '').trim() });
    }
  }
  if (roles.includes('subheadline')) {
    const sub = takeLine((l) => l.length <= 120) ?? '';
    if (sub) blocks.push({ id: 'subheadline', role: 'subheadline', text: sub });
  }
  if (roles.includes('cta')) {
    const cta = analysis.cta || takeLine((l) => CTA_HINT.test(l)) || '';
    if (cta) blocks.push({ id: 'cta', role: 'cta', text: cta.split('\n')[0].slice(0, 60) });
  }
  if (roles.includes('price')) {
    const price = takeLine((l) => /[$€£¥]|\b(?:rp|idr|usd|eur)\b/i.test(l) && l.length <= 60);
    if (price) blocks.push({ id: 'price', role: 'price', text: price });
  }
  if (roles.includes('date')) {
    const date = takeLine((l) => /\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/-]\d{1,2}|\d{1,2}\s*(?:am|pm)|\d{1,2}[:.]\d{2})\b/i.test(l) && l.length <= 80);
    if (date) blocks.push({ id: 'date', role: 'date', text: date });
  }
  if (roles.includes('contact')) {
    const contact = takeLine((l) => /@|(?:\+?\d[\d\s().-]{6,})|(?:www\.|https?:\/\/)/i.test(l) && l.length <= 120);
    if (contact) blocks.push({ id: 'contact', role: 'contact', text: contact });
  }
  if (roles.includes('body')) {
    const body = takeLine((l) => l.length <= 200 && l.split(/\s+/).length >= 6);
    if (body) blocks.push({ id: 'body', role: 'body', text: body });
  }
  if (roles.includes('tagline')) {
    const tag = takeLine((l) => l.length <= 60);
    if (tag) blocks.push({ id: 'tagline', role: 'tagline', text: tag });
  }
  if (roles.includes('details')) {
    // remaining short lines become one contiguous details block
    const rest = sentencePool.filter((l) => !used.has(l) && l.length <= 90).slice(0, 3);
    if (rest.length) blocks.push({ id: 'details', role: 'details', text: rest.join('\n') });
  }

  // every protected fact from the brief must survive somewhere visible
  for (const fact of analysis.must_include) {
    if (!blocks.some((b) => b.text.includes(fact))) {
      const details = blocks.find((b) => b.role === 'details');
      if (details) details.text = `${details.text}\n${fact}`;
      else blocks.push({ id: `fact-${blocks.length}`, role: 'details', text: fact });
    }
  }
  return blocks.filter((b) => b.text.trim());
}

/* ---------------- AI steps ---------------- */

export async function analyzeBrief(brief: string, format: string, brand: string): Promise<BriefAnalysis> {
  try {
    const res = await generate<unknown>('creative_brief_analysis', { brief: brief.slice(0, 6000), format, brand: brand.slice(0, 2000) });
    return briefAnalysisSchema.parse(res.json);
  } catch (err: any) {
    logger.warn('DESIGN', `brief analysis fell back to deterministic: ${String(err?.message).slice(0, 200)}`);
    return fallbackBriefAnalysis(brief);
  }
}

export async function getArtDirection(analysis: BriefAnalysis, brief: string, width: number, height: number, brandPalette: string[] = []): Promise<ArtDirection & { source: 'ai' | 'fallback' }> {
  const fallback = { ...fallbackArtDirection(brief, width, height, brandPalette), source: 'fallback' as const };
  try {
    const res = await generate<unknown>('design_art_direction', {
      analysis: JSON.stringify(analysis).slice(0, 3000),
      width,
      height,
      orientation: height >= width ? 'portrait' : 'landscape',
      references: JSON.stringify({ brand_palette: brandPalette }).slice(0, 2000),
    });
    const parsed = artDirectionSchema.parse(res.json);
    return { ...parsed, palette: brandPalette.length ? mergePalette(brandPalette, parsed.palette) : parsed.palette, source: 'ai' };
  } catch (err: any) {
    logger.warn('DESIGN', `art direction fell back to deterministic: ${String(err?.message).slice(0, 200)}`);
    return fallback;
  }
}

export async function planCopy(brief: string, analysis: BriefAnalysis, direction: ArtDirection, roles: TextRole[]): Promise<ContentBlock[]> {
  try {
    const maxChars = roles.map((r) => `${r} | max ${r === 'headline' ? 60 : r === 'cta' ? 40 : r === 'details' ? 160 : 110} characters`,).join('\n');
    const res = await generate<unknown>('design_copywriting', {
      brief: brief.slice(0, 6000),
      artDirection: JSON.stringify({ concept: direction.concept, hierarchy: direction.hierarchy }).slice(0, 1500),
      blocks: maxChars,
    });
    const parsed = copyPlanSchema.parse(res.json);
    const blocks: ContentBlock[] = [];
    for (const role of roles) {
      const found = parsed.blocks.find((b) => b.id === role || b.id === `${role}-1`);
      const text = found?.text?.trim();
      if (text) blocks.push({ id: role, role, text: text.slice(0, 500) });
    }
    if (blocks.some((b) => b.role === 'headline')) return ensureFacts(blocks, analysis);
    logger.warn('DESIGN', 'copywriting returned no usable headline; using deterministic copy');
    return fallbackCopy(brief, analysis, roles);
  } catch (err: any) {
    logger.warn('DESIGN', `copywriting fell back to deterministic: ${String(err?.message).slice(0, 200)}`);
    return fallbackCopy(brief, analysis, roles);
  }
}

function ensureFacts(blocks: ContentBlock[], analysis: BriefAnalysis): ContentBlock[] {
  const out = blocks.map((b) => ({ ...b }));
  for (const fact of analysis.must_include) {
    if (!out.some((b) => b.text.includes(fact))) {
      const details = out.find((b) => b.role === 'details');
      if (details) details.text = `${details.text}\n${fact}`;
      else out.push({ id: `fact-${out.length}`, role: 'details', text: fact });
    }
  }
  return out;
}

export async function planAssets(brief: string, direction: ArtDirection, library: { id: string; name: string; tags?: string | null }[]): Promise<z.infer<typeof assetPlanSchema>> {
  const fallback = assetPlanSchema.parse({
    needs_background: direction.background === 'image',
    background_prompt: direction.image_prompt,
  });
  try {
    const res = await generate<unknown>('design_asset_planning', {
      brief: brief.slice(0, 4000),
      artDirection: JSON.stringify(direction).slice(0, 2500),
      library: library.map((l) => `${l.id} | ${l.name} | ${l.tags ?? ''}`).join('\n').slice(0, 2000) || '(empty)',
    });
    const parsed = assetPlanSchema.parse(res.json);
    return { ...parsed, library_asset_ids: parsed.library_asset_ids.filter((id) => library.some((l) => l.id === id)) };
  } catch (err: any) {
    logger.warn('DESIGN', `asset planning fell back to deterministic: ${String(err?.message).slice(0, 200)}`);
    return fallback;
  }
}

export async function variantDirections(base: ArtDirection, analysis: BriefAnalysis, width: number, height: number, count: number): Promise<ArtDirection[]> {
  const rotations = STRATEGY_ROTATION.filter((c) => c !== base.composition);
  const fallbacks: ArtDirection[] = rotations.slice(0, Math.max(0, count)).map((composition, i) => ({
    ...base,
    composition,
    concept: `${base.concept} — ${composition.replace(/_/g, ' ')}`,
    palette: PALETTES[(hashString(base.concept + composition) + i) % PALETTES.length],
    typography: { ...base.typography, scale: Math.max(0.9, Math.min(1.8, base.typography.scale * (i % 2 ? 1.15 : 0.9))), uppercase_headline: i % 2 === 0 },
  }));
  try {
    const res = await generate<unknown>('design_variants', {
      analysis: JSON.stringify(analysis).slice(0, 2500),
      width,
      height,
      count,
      artDirection: JSON.stringify(base).slice(0, 2500),
    });
    const parsed = variantsSchema.parse(res.json);
    const variants = parsed.variants.slice(0, count).map((v) => artDirectionSchema.parse({ ...v, hierarchy: base.hierarchy, texture: base.texture, image_prompt: v.image_prompt || '' }));
    while (variants.length < Math.min(count, fallbacks.length)) variants.push(fallbacks[variants.length]);
    return variants;
  } catch (err: any) {
    logger.warn('DESIGN', `variants fell back to deterministic rotation: ${String(err?.message).slice(0, 200)}`);
    return fallbacks;
  }
}

function mergePalette(brand: string[], proposed: string[]): string[] {
  const out: string[] = [];
  for (const c of [...brand, ...proposed]) {
    if (!out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
    if (out.length >= 6) break;
  }
  return out;
}
