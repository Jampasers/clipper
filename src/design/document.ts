import { z } from 'zod';

/**
 * DesignDocument — the versioned, editable core of Design Studio.
 *
 * The canonical editable form is layers (text/image/shape/group), never a
 * flattened bitmap. All rendering (SVG, export) is derived from this document.
 * Layers never carry filesystem paths: image/shape layers reference document
 * assets by local id, and document assets reference the asset library by
 * `assetId`. Path resolution happens only on the server, from SQLite metadata.
 */

export const DESIGN_SCHEMA_VERSION = 1;

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'ids must be alphanumeric (dash/underscore allowed)');
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'colors must be #rgb/#rrggbb/#rrggbbaa hex');
const finite = z.number().finite();
const opacity = finite.min(0).max(1);

export const gradientSchema = z.object({
  type: z.literal('linear'),
  /** degrees, 0 = left→right, 90 = top→bottom */
  angle: finite.min(0).max(360).default(90),
  stops: z
    .array(z.object({ offset: opacity, color: hexColor }))
    .min(2)
    .max(8),
});
export type Gradient = z.infer<typeof gradientSchema>;

const fill = z.union([hexColor, z.literal('none'), gradientSchema]);

const strokeSchema = z.object({
  color: hexColor,
  width: finite.min(0).max(200).default(0),
  dash: z.array(finite.min(0.1).max(500)).max(8).optional(),
});

const shadowSchema = z.object({
  color: hexColor.default('#00000066'),
  blur: finite.min(0).max(200).default(12),
  offsetX: finite.min(-200).max(200).default(0),
  offsetY: finite.min(-200).max(200).default(6),
});

const baseLayerShape = {
  id,
  name: z.string().max(120).optional(),
  x: finite.min(-20000).max(20000),
  y: finite.min(-20000).max(20000),
  width: finite.min(0.1).max(20000),
  height: finite.min(0.1).max(20000),
  /** rotation in degrees around the layer center */
  rotation: finite.min(-3600).max(3600).default(0),
  opacity: opacity.default(1),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
};

export const textLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal('text'),
  text: z.string().max(4000),
  style: z
    .object({
      fontFamily: z.string().max(120).default('Arial'),
      fontSize: finite.min(1).max(2000).default(48),
      fontWeight: z.number().int().min(100).max(900).default(400),
      lineHeight: finite.min(0.5).max(4).default(1.2),
      letterSpacing: finite.min(-50).max(200).default(0),
      align: z.enum(['left', 'center', 'right']).default('left'),
      color: hexColor.default('#ffffff'),
      uppercase: z.boolean().default(false),
      /** 'shrink' reduces the effective font size until the text fits the box */
      overflow: z.enum(['visible', 'clip', 'shrink']).default('visible'),
      stroke: strokeSchema.optional(),
      shadow: shadowSchema.optional(),
    })
    .default({}),
});

export const imageLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal('image'),
  /** local reference into document.assets */
  assetRef: id,
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  /** crop focal point for cover fit, 0..1 */
  focusX: opacity.default(0.5),
  focusY: opacity.default(0.5),
  cornerRadius: finite.min(0).max(5000).default(0),
  border: strokeSchema.optional(),
  shadow: shadowSchema.optional(),
});

export const shapeLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line', 'triangle']).default('rect'),
  fill: fill.default('#ffffff'),
  stroke: strokeSchema.optional(),
  cornerRadius: finite.min(0).max(5000).default(0),
  shadow: shadowSchema.optional(),
});

export const groupLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal('group'),
  /** member layer ids (present in the same document, not groups themselves) */
  children: z.array(id).max(200),
});

export const layerSchema = z.discriminatedUnion('type', [
  textLayerSchema,
  imageLayerSchema,
  shapeLayerSchema,
  groupLayerSchema,
]);
export type DesignLayer = z.infer<typeof layerSchema>;
export type TextLayer = z.infer<typeof textLayerSchema>;
export type ImageLayer = z.infer<typeof imageLayerSchema>;
export type ShapeLayer = z.infer<typeof shapeLayerSchema>;
export type GroupLayer = z.infer<typeof groupLayerSchema>;

export const documentAssetSchema = z.object({
  id,
  /** design_assets row id (the library asset). Never a filesystem path. */
  assetId: z.string().min(1).max(64),
  name: z.string().max(160).optional(),
  mime: z.string().max(100).optional(),
  width: finite.min(1).max(20000).optional(),
  height: finite.min(1).max(20000).optional(),
  /** provenance: 'generated' assets came from the image provider */
  source: z.enum(['upload', 'generated', 'library']).default('library'),
});
export type DocumentAsset = z.infer<typeof documentAssetSchema>;

export const canvasSchema = z.object({
  width: z.number().int().min(16).max(10000),
  height: z.number().int().min(16).max(10000),
  background: z
    .object({
      mode: z.enum(['color', 'image', 'none']).default('color'),
      color: hexColor.optional(),
      assetRef: id.optional(),
      /** cover fit for background images */
      blur: finite.min(0).max(100).default(0),
    })
    .default({}),
  /** inner safe margin (print/social), pixels */
  safeArea: z
    .object({
      top: finite.min(0).max(2000).default(0),
      right: finite.min(0).max(2000).default(0),
      bottom: finite.min(0).max(2000).default(0),
      left: finite.min(0).max(2000).default(0),
    })
    .default({}),
});

export const exportSettingsSchema = z.object({
  format: z.enum(['png', 'jpg', 'svg', 'pdf']).default('png'),
  scale: finite.min(0.25).max(4).default(1),
  quality: z.number().int().min(1).max(100).default(92),
});

export const designMetadataSchema = z.object({
  title: z.string().max(200).default('Untitled design'),
  category: z.string().max(60).optional(),
  tags: z.array(z.string().max(48)).max(30).default([]),
  /** the originating brief — kept so review can check brief compliance */
  brief: z.string().max(8000).optional(),
  strategy: z.string().max(60).optional(),
  palette: z.array(hexColor).max(12).optional(),
  brand: z.record(z.string().max(4000)).optional(),
  generation: z
    .object({
      model: z.string().max(200).optional(),
      artDirection: z.string().max(4000).optional(),
      generatedAt: z.string().max(40).optional(),
      variantOf: z.string().max(64).optional(),
    })
    .optional(),
});

export const designDocumentSchema = z.object({
  id,
  schemaVersion: z.number().int().min(1).max(1000),
  revision: z.number().int().min(1).max(1_000_000).default(1),
  canvas: canvasSchema,
  metadata: designMetadataSchema.default({}),
  assets: z.array(documentAssetSchema).max(200).default([]),
  layers: z.array(layerSchema).max(500).default([]),
  settings: z.object({ export: exportSettingsSchema.default({}) }).default({}),
});
export type DesignDocument = z.infer<typeof designDocumentSchema>;

export class DesignSchemaError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DesignSchemaError';
  }
}

export function emptyDocument(opts: {
  id: string;
  width?: number;
  height?: number;
  title?: string;
  background?: string;
}): DesignDocument {
  return designDocumentSchema.parse({
    id: opts.id,
    schemaVersion: DESIGN_SCHEMA_VERSION,
    canvas: { width: opts.width ?? 1080, height: opts.height ?? 1080, background: { mode: 'color', color: opts.background ?? '#101322' } },
    metadata: { title: opts.title ?? 'Untitled design' },
  });
}

/**
 * Parse + validate a raw value (AI output, DB JSON, API body).
 * Rejects invalid asset references and group children pointing at nothing.
 */
export function parseDesignDocument(raw: unknown): DesignDocument {
  const migrated = migrateDocument(raw);
  const result = designDocumentSchema.safeParse(migrated);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new DesignSchemaError(`invalid design document: ${first.path.join('.') || '(root)'}: ${first.message}`);
  }
  const doc = result.data;
  validateReferences(doc);
  return doc;
}

export function validateReferences(doc: DesignDocument): void {
  const assetIds = new Set(doc.assets.map((a) => a.id));
  const layerIds = new Set<string>();
  for (const layer of doc.layers) {
    if (layerIds.has(layer.id)) throw new DesignSchemaError(`duplicate layer id "${layer.id}"`);
    layerIds.add(layer.id);
    if (layer.type === 'image' && !assetIds.has(layer.assetRef)) {
      throw new DesignSchemaError(`image layer "${layer.id}" references missing asset "${layer.assetRef}"`);
    }
  }
  if (doc.canvas.background.mode === 'image') {
    const ref = doc.canvas.background.assetRef;
    if (!ref || !assetIds.has(ref)) throw new DesignSchemaError(`canvas background references missing asset "${ref ?? ''}"`);
  }
  for (const layer of doc.layers) {
    if (layer.type === 'group') {
      for (const childId of layer.children) {
        const child = doc.layers.find((l) => l.id === childId);
        if (!child) throw new DesignSchemaError(`group "${layer.id}" references missing layer "${childId}"`);
        if (child.type === 'group') throw new DesignSchemaError(`group "${layer.id}" cannot contain group "${childId}"`);
      }
    }
  }
}

/**
 * Safe migration hook. v1 is current; future schema versions append cases here.
 * Unknown/newer versions are rejected instead of guessed at.
 */
export function migrateDocument(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') throw new DesignSchemaError('design document must be an object');
  const doc = raw as Record<string, unknown>;
  const version = Number(doc.schemaVersion ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new DesignSchemaError(`invalid schemaVersion "${String(doc.schemaVersion)}"`);
  if (version > DESIGN_SCHEMA_VERSION) {
    throw new DesignSchemaError(`design schema version ${version} is newer than supported (${DESIGN_SCHEMA_VERSION})`);
  }
  // future: if (version === 1) doc = upFrom1to2(doc)
  return doc;
}

export function serializeDesignDocument(doc: DesignDocument): string {
  return JSON.stringify(doc);
}

/** Text layers whose content must never be silently rewritten by AI repair. */
export function isProtectedTextLayer(layer: DesignLayer): boolean {
  if (layer.type !== 'text') return false;
  return /\d|[$€£¥]|@|(?:\+?\d[\d\s().-]{6,})|(?:www\.|https?:\/\/)|(?:rp\.?\s?\d|idr|usd|eur|\$|€|£)/i.test(layer.text);
}

export { hexColor };
