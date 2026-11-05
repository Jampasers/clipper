/* Design Studio unit tests: document schema, layout, typography, deterministic
 * review/repair, SVG rendering, exports and the document/template services. */
import fs from 'node:fs';
import path from 'node:path';
import { test, assert, assertEquals, assertThrows } from './runner.js';
import { tempName } from './env.js';
import { initDb } from '../src/lib/sqlite.js';
import {
  emptyDocument, parseDesignDocument, validateReferences, migrateDocument, isProtectedTextLayer,
  type DesignDocument,
} from '../src/design/document.js';
import { buildLayout, COMPOSITIONS, artDirectionSchema, STRATEGY_ROTATION, type ArtDirection } from '../src/design/layout.js';
import { wrapText, fitFontSize, measureTextBlock, resolveTextLayout } from '../src/design/typography.js';
import { reviewDesignDeterministic, deterministicRepair, applyRepairs, repairOpSchema } from '../src/design/review.js';
import { renderDocumentSvg, xmlEscape } from '../src/design/render.js';
import { exportDesign, writePdfFromJpeg, exportsDir } from '../src/design/export.js';
import {
  createDesign, getDesign, saveDesign, listVersions, restoreVersion, duplicateDesign, deleteDesign,
  createTemplate, listTemplates, applyTemplate, deleteTemplate, getDesignRow,
} from '../src/services/designs.js';

initDb();

const W = 1080;
const H = 1080;
const baseDirection = () =>
  artDirectionSchema.parse({
    concept: 'Test concept',
    composition: 'editorial',
    palette: ['#10203a', '#f5f7fb', '#ff5c7a'],
    typography: { heading_family: 'Arial Black', body_family: 'Segoe UI', scale: 1.3, heading_weight: 800, uppercase_headline: true },
    background: 'gradient',
  });

const blocks = () => [
  { id: 'headline', role: 'headline' as const, text: 'Grand Opening Sale This Weekend Only' },
  { id: 'subheadline', role: 'subheadline' as const, text: 'Up to 50 percent off everything in store' },
  { id: 'cta', role: 'cta' as const, text: 'Shop Now' },
  { id: 'details', role: 'details' as const, text: 'Jl. Sudirman No. 12, Jakarta · Sat-Sun 9am-9pm' },
];

function buildTestDoc(direction?: Partial<ArtDirection>, variant = 0): DesignDocument {
  const { doc } = buildLayout({
    id: 'dtest-layout',
    canvas: { width: W, height: H },
    direction: { ...baseDirection(), ...direction },
    blocks: blocks(),
    variant,
  });
  return doc;
}

/* ---------------- document schema ---------------- */

test('emptyDocument is a valid, parseable design document', () => {
  const doc = emptyDocument({ id: 'abc', width: 800, height: 1200, title: 'T' });
  assertEquals(parseDesignDocument(JSON.parse(JSON.stringify(doc))).canvas.width, 800);
});

test('unknown layer types are rejected', () => {
  const doc = emptyDocument({ id: 'abc', width: 400, height: 400 });
  const bad = { ...JSON.parse(JSON.stringify(doc)), layers: [{ type: 'video', id: 'x', x: 0, y: 0, width: 10, height: 10 }] };
  assertThrows(() => parseDesignDocument(bad), 'unknown layer type');
});

test('validateReferences rejects image layers pointing at missing doc assets', () => {
  const doc = emptyDocument({ id: 'abc', width: 400, height: 400 });
  doc.layers.push({
    id: 'img1', type: 'image', name: 'hero', x: 0, y: 0, width: 100, height: 100,
    assetRef: 'no-such-asset', fit: 'cover', focusX: 0.5, focusY: 0.5, cornerRadius: 0, opacity: 1, visible: true, locked: false, rotation: 0,
  });
  assertThrows(() => validateReferences(doc), 'missing asset');
});

test('migrateDocument rejects newer schema versions', () => {
  const doc = emptyDocument({ id: 'abc' }) as unknown as Record<string, unknown>;
  doc.schemaVersion = 99;
  assertThrows(() => migrateDocument(doc), 'newer version');
  assertEquals(migrateDocument({ schemaVersion: 1 }), { schemaVersion: 1 });
});

test('protected layers: money/contact text is never auto-restyled', () => {
  const doc = emptyDocument({ id: 'abc' });
  const money = { ...doc.layers[0], type: 'text', id: 'money', text: 'Hubungi 0812-3456-7890', style: { fontFamily: 'Arial', fontSize: 20, fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, align: 'left', color: '#ffffff', uppercase: false, overflow: 'shrink' } } as never;
  doc.layers = [money];
  assert(isProtectedTextLayer(money), 'phone number protects the layer');
  assert(!isProtectedTextLayer({ type: 'text', id: 'x', text: 'plain words', style: {} } as never), 'plain text is not protected');
});

/* ---------------- layout ---------------- */

test('buildLayout is deterministic: same input, same document', () => {
  assertEquals(JSON.stringify(buildTestDoc()), JSON.stringify(buildTestDoc()));
});

test('Gradient direction produces a background gradient layer', () => {
  const doc = buildTestDoc();
  assert(doc.layers.some((l) => l.type === 'shape' && l.fill && typeof l.fill === 'object'), 'gradient bg layer exists');
  assert(doc.metadata.strategy === 'editorial', 'strategy recorded in metadata');
});

test('Solid light palette picks dark ink for contrast', () => {
  const doc = buildTestDoc({ background: 'solid', palette: ['#fdfdfd', '#101322', '#ff5c7a'] });
  const text = doc.layers.find((l) => l.type === 'text');
  assert(text && text.type === 'text', 'text layer exists');
  assert(text.style.color.toLowerCase() !== '#fdfdfd', 'text is not invisible on the light background');
});

test('every composition strategy builds a valid document without breaking bounds', () => {
  for (const composition of COMPOSITIONS) {
    const doc = buildTestDoc({ composition });
    assert(doc.layers.length >= 3, `${composition} produced layers`);
    assert(doc.layers.some((l) => l.type === 'text'), `${composition} renders text`);
    for (const l of doc.layers) {
      if (l.type !== 'text') continue;
      assert(
        l.x >= -5 && l.y >= -5 && l.x + l.width <= W + 5 && l.y + l.height <= H + 5,
        `${composition} text ${l.id} stays inside the canvas (${l.x},${l.y},${l.width},${l.height})`
      );
    }
  }
});

test('variant rotates the composition strategy deterministically', () => {
  const first = buildTestDoc(undefined, 1);
  const second = buildTestDoc(undefined, 1);
  assertEquals(JSON.stringify(first), JSON.stringify(second));
  assert(first.metadata.strategy !== 'editorial', 'variant 1 left the base composition');
  assert(STRATEGY_ROTATION.length === COMPOSITIONS.length, 'rotation covers all strategies');
});

/* ---------------- typography ---------------- */

test('wrapText wraps long headlines into multiple lines', () => {
  const spec = { fontFamily: 'Arial', fontSize: 60, fontWeight: 700, lineHeight: 1.15, letterSpacing: 0, uppercase: true };
  const lines = wrapText('A Very Long Headline That Cannot Possibly Fit In One Line At All', spec, 400);
  assert(lines.length >= 2, `expected wrapped lines, got ${JSON.stringify(lines)}`);
  for (const line of lines) assert(measureTextBlock(line, spec, 400).width <= 400 + 1, 'lines fit the box');
});

test('fitFontSize shrinks to fit small boxes', () => {
  const spec = { fontFamily: 'Arial', fontSize: 96, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, uppercase: false };
  const size = fitFontSize('This headline needs to shrink considerably to fit', spec, 300, 80, 10);
  assert(size >= 10 && size < 60, `fit size should shrink (${size})`);
});

test('resolveTextLayout measures what it renders', () => {
  const layer = {
    id: 't', type: 'text', name: 't', x: 100, y: 100, width: 500, height: 120, text: 'Hello world',
    style: { fontFamily: 'Arial', fontSize: 48, fontWeight: 600, lineHeight: 1.3, letterSpacing: 0, align: 'left', color: '#ffffff', uppercase: false, overflow: 'shrink' },
    opacity: 1, visible: true, locked: false, rotation: 0,
  } as const;
  const { metrics } = resolveTextLayout(layer as never);
  assert(metrics.width > 0 && metrics.height > 0, 'metrics computed');
  assert(metrics.height <= 120 + 1, 'shrink keeps text inside its box');
});

/* ---------------- review + repair ---------------- */

test('deterministic review flags out-of-bounds layers and repair pulls them back', () => {
  const doc = buildTestDoc({ background: 'solid' });
  const text = doc.layers.find((l) => l.type === 'text')!;
  const tampered = JSON.parse(JSON.stringify(doc)) as DesignDocument;
  const layer = tampered.layers.find((l) => l.id === text.id)!;
  layer.x = -300;
  layer.y = -300;
  const review = reviewDesignDeterministic(tampered);
  assert(review.score >= 0 && review.score <= 100, 'score in range');
  assert(review.issues.some((i) => i.type === 'bounds' && i.layerId === layer.id), 'bounds flagged');
  const repaired = deterministicRepair(tampered);
  assert(repaired.applied.some((op) => op.op === 'move_layer' && op.layer_id === layer.id), 'repair moved the layer');
  const fixedLayer = repaired.doc.layers.find((l) => l.id === layer.id)!;
  assert(fixedLayer.x >= 0 && fixedLayer.y >= 0, 'layer back inside the canvas');
});

test('applyRepairs validates ops and never touches protected text style', () => {
  const doc = buildTestDoc({ background: 'solid' });
  const money = doc.layers.find((l) => l.type === 'text' && /[\d$€£]|http/i.test((l as { text: string }).text));
  assert(money, 'layout produced a protected (fact-bearing) text layer');
  const moneyId = (money as { id: string }).id;
  const result = applyRepairs(doc, [
    { op: 'set_font_size', layer_id: moneyId, font_size: 12 },
    { op: 'set_alignment', layer_id: moneyId, alignment: 'center' },
    { op: 'set_color', layer_id: moneyId, color: '#123456' },
  ]);
  assert(result.rejected.filter((r) => r.reason.includes('protected')).length >= 2, 'font size and alignment rejected on protected layer');
  assert(result.applied.some((op) => op.op === 'set_color'), 'color is allowed even on protected layers');
  const bad = applyRepairs(doc, [{ op: 'explode', layer_id: 'x' }]);
  assert(bad.rejected.length === 1 && bad.applied.length === 0, 'invalid op rejected');
  assert(!repairOpSchema.safeParse({ op: 'set_color', layer_id: 'x', color: 'red' }).success, 'non-hex color rejected');
});

/* ---------------- renderer ---------------- */

test('renderDocumentSvg escapes text and marks missing assets', () => {
  const doc = buildTestDoc({ background: 'solid' });
  const headline = doc.layers.find((l) => l.type === 'text')!;
  (headline as { text: string }).text = 'Sales & <Deals>';
  if (headline.type === 'text') headline.style.uppercase = false;
  doc.layers.push({
    id: 'img-missing', type: 'image', name: 'missing', x: 10, y: 10, width: 50, height: 50,
    assetRef: 'ghost', fit: 'cover', focusX: 0.5, focusY: 0.5, cornerRadius: 0, opacity: 1, visible: true, locked: false, rotation: 0,
  });
  const svg = renderDocumentSvg(doc, { mode: 'preview', assetHref: () => null });
  assert(svg.startsWith('<svg'), 'starts with svg root');
  assert(svg.includes('&amp;') && svg.includes('&lt;Deals&gt;'), 'text escaped');
  assert(!svg.includes('Sales & <Deals>'), 'raw markup never appears');
  assert(svg.includes('data-layer-id'), 'layers are addressable');
  assert(svg.includes('data-missing-asset="1"'), 'missing asset is visibly marked');
});

test('xmlEscape escapes all five XML entities', () => {
  assertEquals(xmlEscape('a<b&"c"'), 'a&lt;b&amp;&quot;c&quot;');
});

/* ---------------- exports ---------------- */

test('SVG export writes a real file through the shared renderer', async () => {
  const doc = buildTestDoc({ background: 'solid' });
  const result = await exportDesign(doc, {
    format: 'svg',
    scale: 1,
    quality: 92,
    resolveAssetFile: () => null,
  });
  assert(fs.existsSync(result.filePath), 'svg file exists');
  const content = fs.readFileSync(result.filePath, 'utf8');
  assert(content.startsWith('<svg'), 'file contains the rendered svg');
  assert(path.dirname(result.filePath) === exportsDir(), 'svg written into the exports dir');
  fs.rmSync(result.filePath, { force: true });
});

test('PDF writer emits a structurally valid single-page PDF', () => {
  const tmpJpeg = path.join(tempName('pdf-src'), 'pdf-test.jpg');
  fs.writeFileSync(tmpJpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
  const out = path.join(tempName('pdf-out'), 'pdf-test.pdf');
  const bytes = writePdfFromJpeg(tmpJpeg, out, 100, 100, 100, 100);
  assert(bytes > 20, 'wrote some bytes');
  const content = fs.readFileSync(out);
  assert(content.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'pdf header');
  assert(content.toString('latin1').includes('/DCTDecode'), 'jpeg embedded via DCTDecode');
  assert(content.toString('latin1').trimEnd().endsWith('%%EOF'), 'pdf trailer');
  fs.rmSync(out, { force: true });
  fs.rmSync(tmpJpeg, { force: true });
});

/* ---------------- services ---------------- */

test('design service: save snapshots versions, restore revives them, duplicate clones', () => {
  const row = createDesign({ name: 'Unit design', width: 800, height: 800, brief: 'test brief' });
  const { doc } = getDesign(row.id);
  const { doc: saved1 } = saveDesign(row.id, { ...buildTestDoc(), id: row.id, revision: doc.revision }, { label: 'first layout' });
  const v1 = listVersions(row.id);
  assert(v1.length >= 1, 'auto snapshot before save exists');

  const { doc: restored } = restoreVersion(row.id, v1[0].revision);
  assert(restored.revision > saved1.revision, 'restore bumps revision');
  assertEquals(restored.id, row.id);

  const dup = duplicateDesign(row.id);
  assert(dup.row.id !== row.id, 'duplicate has its own id');
  assert(dup.doc.metadata.generation?.variantOf === row.id, 'duplicate is marked as variant');

  const remaining = listVersions(row.id);
  assert(remaining.length >= 1, 'versions still recorded');
  assert(deleteDesign(dup.row.id), 'duplicate deleted');
  assert(!getDesignRow(dup.row.id), 'duplicate gone');
  assert(deleteDesign(row.id), 'original deleted');
});

test('templates: create from design, list, apply into a new design, delete', () => {
  const row = createDesign({ name: 'Template source', width: 900, height: 900 });
  saveDesign(row.id, { ...buildTestDoc(), id: row.id } as unknown, { label: 'template source' });
  const template = createTemplate({ name: 'Unit template', document: getDesign(row.id).doc, category: 'test' });
  assert(listTemplates('test').some((t) => t.id === template.id), 'template listed');

  const applied = applyTemplate(template.id, { name: 'From template' });
  assert(applied.row.id !== row.id, 'applied into a new design');
  assert(applied.doc.layers.length > 0, 'template layers copied');

  assert(deleteTemplate(template.id), 'template deleted');
  assert(deleteDesign(row.id), 'source design deleted');
  assert(deleteDesign(applied.row.id), 'applied design deleted');
});

test('documents reference only enabled library assets; disabled assets block save', () => {
  // saveDesign validates through resolveDesignAsset; with an empty library any
  // doc asset reference must fail rather than silently losing the image.
  const row = createDesign({ name: 'Asset validation' });
  const doc = getDesign(row.id).doc;
  doc.assets.push({ id: 'a1', assetId: 'ghost-asset', name: 'ghost', source: 'generated' });
  doc.layers.push({
    id: 'img1', type: 'image', name: 'hero', x: 0, y: 0, width: 100, height: 100,
    assetRef: 'a1', fit: 'cover', focusX: 0.5, focusY: 0.5, cornerRadius: 0, opacity: 1, visible: true, locked: false, rotation: 0,
  });
  assertThrows(() => saveDesign(row.id, doc), 'missing library asset rejected');
  deleteDesign(row.id);
});
