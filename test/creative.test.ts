/* Pure-logic tests for the adaptive creative editor core:
 * scene log parsing, EDL validation/repair/zoom curve, overlay collisions,
 * adaptive style rules, b-roll relevance scoring and director merging. */
import { test, assert, assertEquals } from './runner.js';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, q } from '../src/lib/sqlite.js';
import { tempName } from './env.js';
import {
  parseSceneLog, parseFaceSamples, classifyShots, summarizeScene, cutsPerMinute, EMPTY_SCENE_ANALYSIS,
} from '../src/services/scene-analysis.js';
import {
  validateEdl, buildZoomKeys, zoomAt, overlayLayout, findCollisions, repairEdl, buildFallbackEdl,
  type EdlContext, type Edl,
} from '../src/services/edl.js';
import { chooseStyle, gradeFilters, GRADE_PROFILES, targetAspect, speechRate } from '../src/services/adaptive-style.js';
import { scoreBrollAssets, resolveBrollPlacements, type BrollRow } from '../src/services/broll.js';
import { buildBaseline, mergeFragment, creativeContext, type CreativeDirectInput } from '../src/services/creative-director.js';
import { buildTimeline } from '../src/services/timeline.js';
import { buildRenderGraph, buildRenderArgs, zoomExprFromKeys, type RenderGraphSpec } from '../src/services/render-graph.js';
import { reviewCreativeStatic, reviewOutputMedia } from '../src/services/quality-review.js';
import { defaultRenderOptions, planOptionsHash } from '../src/services/render-options.js';
import { buildEditingPlan, getOrCreateEditingPlan, PLAN_VERSION } from '../src/services/editing-plan.js';
import { getSettings } from '../src/lib/settings.js';
import type { ReframePlan } from '../src/services/reframe.js';
import type { ClipWord, PlannedWordStyle } from '../src/services/subtitle-plan.js';

initDb();

const ctx: EdlContext = {
  duration: 20,
  aspectRatio: '9:16',
  clipStart: 100,
  clipEnd: 120,
  words: [
    { index: 0, text: 'Rahasianya', start: 100, end: 100.5, segmentIndex: 0 },
    { index: 1, text: '3', start: 100.6, end: 100.8, segmentIndex: 0 },
    { index: 2, text: 'langkah', start: 100.9, end: 101.4, segmentIndex: 0 },
    { index: 3, text: 'gagal', start: 102, end: 102.5, segmentIndex: 0 },
  ],
};

function minimalRaw(extra: Record<string, unknown> = {}) {
  return { version: 1, aspectRatio: '16:9', style: {}, ...extra };
}

function parsedEdl(extra: Record<string, unknown> = {}): Edl {
  const r = validateEdl(minimalRaw(extra), ctx);
  assert(r.ok && r.edl, `expected valid EDL: ${r.errors.join(', ')}`);
  return r.edl!;
}

/* ---------------- scene analysis ---------------- */

test('parseSceneLog extracts brightness, scene cuts and black spans', () => {
  const log = [
    'frame:0    pts:0       pts_time:0',
    'lavfi.signalstats.YAVG=210.50',
    'frame:6    pts:7200    pts_time:1.2',
    'lavfi.signalstats.YAVG=40.20',
    'lavfi.scene_score=0.62',
    '[blackdetect @ 0x55] black_start:2.1 black_end:2.8 black_duration:0.7',
  ].join('\n');
  const p = parseSceneLog(log);
  assertEquals(p.brightness, [{ t: 0, y: 210.5 }, { t: 1.2, y: 40.2 }]);
  assertEquals(p.cuts, [{ t: 1.2, score: 0.62 }]);
  assertEquals(p.blackSpans, [{ start: 2.1, end: 2.8 }]);
});

test('parseFaceSamples keeps point JSON lines and ignores sidecar diagnostics', () => {
  const log = [
    'noise line',
    '{"type":"point","t":0,"cx":0.5,"faces":1,"w":0.22}',
    '{"type":"point","t":0.5,"cx":0.48,"faces":1,"w":0.21}',
    '{"type":"point","t":1.1,"cx":0.4,"faces":0,"w":0}',
    '{"type":"done","samples":3}',
  ].join('\n');
  const faces = parseFaceSamples(log);
  assertEquals(faces.length, 3);
  assertEquals(faces[0], { t: 0, cx: 0.5, faces: 1, w: 0.22 });
  assertEquals(faces[2], { t: 1.1, cx: 0.4, faces: 0, w: 0 });
});

test('classifyShots merges consecutive samples into shot-size hints', () => {
  const hints = classifyShots([
    { t: 0, cx: 0.5, faces: 1, w: 0.22 },
    { t: 0.2, cx: 0.5, faces: 1, w: 0.21 },
    { t: 0.4, cx: 0.5, faces: 1, w: 0.22 },
    { t: 2.0, cx: 0.5, faces: 1, w: 0.05 },
    { t: 2.2, cx: 0.5, faces: 1, w: 0.05 },
    { t: 2.4, cx: 0.5, faces: 1, w: 0.06 },
    { t: 2.6, cx: 0.5, faces: 1, w: 0.12 },
    { t: 2.8, cx: 0.5, faces: 1, w: 0.12 },
    { t: 3.0, cx: 0.5, faces: 1, w: 0.13 },
  ]);
  assertEquals(hints.map((h) => h.size), ['close', 'wide', 'medium'], 'runs under 0.4s are dropped');
  assertEquals(hints[0], { start: 0, end: 0.4, size: 'close' });
});

test('summarizeScene thresholds cuts and flags dark footage; cutsPerMinute normalizes', () => {
  const s = summarizeScene(
    0,
    30,
    { brightness: [{ t: 0, y: 40 }, { t: 1, y: 50 }], cuts: [{ t: 5, score: 0.5 }, { t: 9, score: 0.1 }], blackSpans: [] },
    [
      { t: 0, cx: 0.5, faces: 1, w: 0.2 },
      { t: 0.2, cx: 0.5, faces: 1, w: 0.2 },
      { t: 0.4, cx: 0.5, faces: 1, w: 0.2 },
      { t: 1, cx: 0.5, faces: 0, w: 0 },
    ],
    true
  );
  assert(s.dark, 'avg brightness 45 should be dark');
  assert(!s.bright, 'not bright');
  assertEquals(s.cuts.length, 1, 'only cuts >= 0.35 are significant');
  assertEquals(s.faceCoverage, 0.75);
  assertEquals(s.shotHints.length, 1);
  assertEquals(cutsPerMinute(s), 2);
});

/* ---------------- EDL validation ---------------- */

test('validateEdl clamps, dedupes and drops invalid creatives', () => {
  const r = validateEdl(
    minimalRaw({
      framings: [{ start: 0, end: 6, shot: 'close' }],
      titles: [{ text: 'intro', start: 0.2, end: 0.5 }],
      callouts: [{ text: 'punch', x: 0.01, y: 0.995, start: 2, end: 4 }],
      broll: [
        { assetId: 'unknown', start: 5, end: 7 },
        { assetId: 'b1', start: 18, end: 30 },
        { assetId: 'b1', start: 10, end: 10.4 },
        { query: 'laptop', start: 12, end: 14 },
      ],
      sfx: [{ libraryId: 's1', at: 19.7 }, { libraryId: 's1', at: 25 }],
      emphasis: [
        { text: 'rahasianya', role: 'important' },
        { text: 'not-in-transcript', role: 'important' },
        { text: 'Rahasianya', role: 'hook' },
      ],
    }),
    { ...ctx, brollIds: ['b1'], sfxIds: ['s1'] }
  );
  assert(r.ok && r.edl, `should validate: ${r.errors.join(', ')}`);
  const e = r.edl!;
  assertEquals(e.aspectRatio, '9:16', 'aspect comes from render options');
  assertEquals(e.framings[0].focus, 'speaker', 'schema defaults applied');
  assertEquals(e.titles.length, 0, 'title shorter than MIN_GRAPHIC_DURATION dropped');
  assertEquals(e.callouts[0].x, 0.02);
  assertEquals(e.callouts[0].y, 0.98);
  assertEquals(e.broll.map((b) => [b.start, b.end]), [[12, 14], [18, 20]], 'unknown id dropped, window clamped, short dropped');
  assertEquals(e.sfx.map((s) => s.at), [19.7], 'sfx past the timeline end dropped');
  assertEquals(e.emphasis.map((x) => x.text), ['rahasianya'], 'unknown and duplicate emphasis dropped');
  assert(r.dropped.length >= 4, 'dropped items are reported');
});

test('validateEdl caps picture-in-picture placements at 4', () => {
  const broll = Array.from({ length: 5 }, (_, i) => ({ assetId: 'b1', start: 2 + i * 2, end: 3.5 + i * 2, mode: 'pip' }));
  const r = validateEdl(minimalRaw({ broll }), { ...ctx, brollIds: ['b1'] });
  assertEquals(r.edl!.broll.filter((b) => b.mode === 'pip').length, 4);
  assert(r.dropped.some((d) => d.includes('picture-in-picture')), 'pip overflow reported');
});

test('validateEdl rejects structurally invalid input', () => {
  const r = validateEdl({ version: 99, aspectRatio: '9:16', style: {} }, ctx);
  assert(!r.ok && r.edl === null, 'bad version must fail');
  assert(r.errors.length > 0, 'error message present');
});

/* ---------------- zoom curve ---------------- */

test('buildZoomKeys punches in around the framing and returns to 1', () => {
  const e = parsedEdl({
    framings: [
      { start: 0, end: 6, shot: 'close', ease: 0.5 },
      { start: 6, end: 18, shot: 'medium', ease: 1 },
    ],
  });
  const keys = buildZoomKeys(e.framings, 20);
  assertEquals(zoomAt(keys, 0), 1, 'ramps in from the very start');
  assertEquals(zoomAt(keys, 0.25), 1.24, 'full close-up after the ease-in');
  assertEquals(zoomAt(keys, 3), 1.24, 'holds the close-up');
  assertEquals(zoomAt(keys, 7), 1.1, 'medium framing after the boundary');
  assertEquals(zoomAt(keys, 19.9), 1, 'returns to 1 before the end');
});

test('buildZoomKeys is disabled without framings or when punch-in is off', () => {
  assertEquals(buildZoomKeys([], 20), [{ t: 0, z: 1 }]);
  const e = parsedEdl({ framings: [{ start: 0, end: 6, shot: 'close' }] });
  assertEquals(buildZoomKeys(e.framings, 20, false), [{ t: 0, z: 1 }]);
});

/* ---------------- overlay layout + repair ---------------- */

test('overlayLayout + findCollisions flag stacked center graphics', () => {
  const e = parsedEdl({
    titles: [{ text: 'Big claim', start: 0.5, end: 3.8, position: 'center' }],
    statCards: [{ value: '3x', label: 'faster', start: 0.8, end: 2.6, position: 'center' }],
  });
  const boxes = overlayLayout(e);
  const collisions = findCollisions(boxes);
  assertEquals(collisions.length, 1);
  assertEquals(collisions[0].a.id, 'title:0');
  assertEquals(collisions[0].b.id, 'stat:0');
});

test('spaced graphics do not collide; captions collide with bottom-band graphics', () => {
  const e = parsedEdl({
    titles: [{ text: 'Big claim', start: 0.5, end: 3, position: 'top' }],
    statCards: [{ value: '3x', label: 'faster', start: 6, end: 9, position: 'center' }],
  });
  assertEquals(findCollisions(overlayLayout(e)), []);
  const withCaptions = overlayLayout(e, { captionBand: { y0: 0.72, y1: 0.9 } });
  assertEquals(findCollisions(withCaptions), [], 'top/center graphics stay clear of the caption band');
  const e2 = parsedEdl({
    titles: [{ text: 'Bottom title', start: 0.5, end: 3, position: 'bottom' }],
  });
  const c = findCollisions(overlayLayout(e2, { captionBand: { y0: 0.72, y1: 0.9 } }));
  assert(c.length === 1 && (c[0].a.kind === 'caption' || c[0].b.kind === 'caption'), 'bottom titles hit the caption band');
});

test('repairEdl drops the lower-priority graphic on collision and clamps sfx on clipping', () => {
  const e = parsedEdl({
    sfx: [{ libraryId: 's1', at: 1, volumeDb: -6 }],
    titles: [{ text: 'Big claim', start: 0.5, end: 3.8, position: 'center' }],
    statCards: [{ value: '3x', label: 'faster', start: 0.8, end: 2.6, position: 'center' }],
  });
  const { edl, applied } = repairEdl(e, [
    { code: 'overlay_collision', detail: 'title/stat overlap', ids: ['title:0', 'stat:0'] },
    { code: 'audio_clipping', detail: 'sfx peaks', ids: ['sfx:0'] },
  ]);
  assertEquals(edl.titles.length, 1);
  assertEquals(edl.statCards.length, 0, 'stat card (priority 45) loses to title (70)');
  assertEquals(edl.sfx[0].volumeDb, -12, 'sfx attenuated by 6 dB');
  assert(applied.length >= 2, 'repairs are reported');
});

test('repairEdl drops the graphic colliding with the caption band, never the captions', () => {
  const e = parsedEdl({
    titles: [{ text: 'Big claim', start: 0.5, end: 3.8, position: 'center' }],
  });
  const { edl, applied } = repairEdl(e, [
    { code: 'overlay_collision', detail: 'caption <-> title overlap 3.3s', ids: ['captions', 'title:0'] },
  ]);
  assertEquals(edl.titles.length, 0, 'title overlapping the caption band is dropped');
  assert(applied[0].includes('title:0'), `reported the dropped title (${applied[0]})`);
});

/* ---------------- deterministic fallback + style engine ---------------- */

const words: ClipWord[] = [
  { index: 0, text: 'Rahasianya', start: 100, end: 100.5, segmentIndex: 0 },
  { index: 1, text: '3', start: 100.6, end: 100.8, segmentIndex: 0 },
  { index: 2, text: 'langkah', start: 100.9, end: 101.4, segmentIndex: 0 },
];
const subtitlePlan: PlannedWordStyle[] = [
  { index: 1, role: 'number', animation: 'pop', priority: 8 },
  { index: 2, role: 'important', color: '#FFD400', animation: 'pop', priority: 6 },
];

test('buildFallbackEdl produces a valid deterministic plan with hook framing and emphasis', () => {
  const style = chooseStyle({
    aspect: '9:16', sourceAspect: 16 / 9, duration: 20,
    scene: { ...EMPTY_SCENE_ANALYSIS, faceCoverage: 0.8 }, hasHook: true, speechRate: 3, hasBrollLibrary: false,
  });
  const edl = buildFallbackEdl({
    aspectRatio: '9:16', duration: 20, clipStart: 100, clipEnd: 120, style,
    title: 'Tiga langkah rahasia', hookEnd: 4, scene: { ...EMPTY_SCENE_ANALYSIS, faceCoverage: 0.8 }, words, subtitlePlan,
  });
  const r = validateEdl(edl, ctx);
  assert(r.ok && r.edl, `fallback EDL must validate: ${r.errors.join(', ')}`);
  assertEquals(r.edl!.framings.length, 2, 'hook close-up + body medium');
  assertEquals(r.edl!.titles[0].text, 'Tiga langkah rahasia');
  assertEquals(r.edl!.emphasis.map((x) => x.text), ['3', 'langkah']);
  assertEquals(r.edl!.music, null, 'no music plan means no music');
});

test('chooseStyle follows deterministic signal rules', () => {
  const scene = (opts: { y: number; dark: boolean; bright: boolean }, cuts: number, faces: number) => ({
    ...EMPTY_SCENE_ANALYSIS, windowStart: 0, windowEnd: 30, avgBrightness: opts.y, dark: opts.dark, bright: opts.bright,
    faces: [], faceCoverage: faces,
    cuts: Array.from({ length: cuts }, (_, i) => ({ t: i + 1, score: 0.8 })),
  });
  const dark = chooseStyle({ aspect: '9:16', sourceAspect: 16 / 9, duration: 30, scene: scene({ y: 40, dark: true, bright: false }, 0, 0.6), hasHook: true, speechRate: 1, hasBrollLibrary: false });
  assertEquals(dark.grade, 'warm');
  assertEquals(dark.transition.type, 'fade');
  assert(!dark.edgeFade, 'hook present disables edge fades');
  assert(dark.progressBar, '30s clip gets a progress bar');
  assert(dark.punchIn, 'tracked faces enable punch-in');

  const bright = chooseStyle({ aspect: '9:16', sourceAspect: 16 / 9, duration: 30, scene: scene({ y: 230, dark: false, bright: true }, 0, 0), hasHook: false, speechRate: 1, hasBrollLibrary: false });
  assertEquals(bright.grade, 'cool');
  assert(bright.edgeFade, 'no hook enables edge fades');
  assert(!bright.punchIn, 'no faces disables punch-in');

  const busy = chooseStyle({ aspect: '9:16', sourceAspect: 16 / 9, duration: 20, scene: scene({ y: 120, dark: false, bright: false }, 4, 0.5), hasHook: true, speechRate: 2, hasBrollLibrary: false });
  assertEquals(busy.grade, 'cinematic', '4 cuts in 30s normalizes above the cinematic threshold');

  const wideNoFace = chooseStyle({ aspect: '9:16', sourceAspect: 2.4, duration: 12, scene: scene({ y: 120, dark: false, bright: false }, 0, 0.05), hasHook: true, speechRate: 1, hasBrollLibrary: false });
  assertEquals(wideNoFace.backgroundFill, 'fill-blur', 'ultra-wide source with no subject gets blurred fill');
});

test('gradeFilters maps presets to real ffmpeg filters', () => {
  assertEquals(gradeFilters(GRADE_PROFILES.none), []);
  const warm = gradeFilters(GRADE_PROFILES.warm);
  assert(warm.some((f) => f.startsWith('eq=')), 'eq present');
  assert(warm.some((f) => f.startsWith('colorbalance=')), 'colorbalance present');
  assert(gradeFilters(GRADE_PROFILES.cinematic).some((f) => f.startsWith('vignette=')), 'vignette present');
  assertEquals(targetAspect('1:1'), 1);
});

test('speechRate counts words overlapping the window only', () => {
  const rate = speechRate([{ start: 0, end: 1 }, { start: 5, end: 6 }, { start: 30, end: 31 }], 4, 8);
  assertEquals(rate, 0.25);
});

/* ---------------- b-roll library ---------------- */

function insertBroll(id: string, name: string, tags: string, kind: 'video' | 'image', duration: number | null): string {
  const dir = tempName('broll-assets');
  const file = path.join(dir, `${id}.${kind === 'image' ? 'png' : 'mp4'}`);
  fs.writeFileSync(file, 'x');
  q.run(
    `INSERT INTO broll_assets (id, name, file_path, mime, kind, duration, tags, enabled) VALUES (?,?,?,?,?,?,?,1)`,
    id, name, file, kind === 'image' ? 'image/png' : 'video/mp4', kind, duration, tags
  );
  return file;
}

test('scoreBrollAssets ranks tag hits and penalizes too-short videos', () => {
  insertBroll('b-laptop', 'laptop coding desk', 'laptop,coding,technology', 'video', 6);
  insertBroll('b-short', 'laptop closeup', 'laptop', 'video', 1.2);
  insertBroll('b-nature', 'beach sunset waves', 'nature,beach', 'image', null);
  const mine = new Set(['b-laptop', 'b-short', 'b-nature']);
  const rows = q.all<BrollRow>('SELECT * FROM broll_assets').filter((r) => mine.has(r.id));
  const ranked = scoreBrollAssets('laptop coding', 'work on a laptop', rows, 3);
  assertEquals(ranked[0].asset.id, 'b-laptop');
  assert(ranked[0].score >= 10, `tag hits + context + duration fit should score high (got ${ranked[0].score})`);
  assert(ranked.find((r) => r.asset.id === 'b-short'), 'short video still scores via tags');
  assert(!ranked.find((r) => r.asset.id === 'b-nature'), 'unrelated asset is filtered out');
});

test('resolveBrollPlacements maps queries, clamps video windows and reports drops', () => {
  // unique tags keep this deterministic whatever other suites inserted
  insertBroll('b-qf', 'quantumflux reactor', 'quantumflux,reactor', 'video', 6);
  const q1 = resolveBrollPlacements(
    [{ assetId: null, query: 'quantumflux', mode: 'cover', position: 'bottom-right', sizePercent: 34, start: 0, end: 6 }],
    'reactor chamber'
  );
  assertEquals(q1.specs.length, 1);
  assertEquals(q1.specs[0].asset.id, 'b-qf');
  assertEquals(q1.specs[0].end, 5.9, 'clamped to the asset duration minus a safety frame');

  const q2 = resolveBrollPlacements(
    [{ assetId: 'missing', query: null, mode: 'cover', position: 'bottom-right', sizePercent: 34, start: 0, end: 2 }],
    ''
  );
  assertEquals(q2.specs.length, 0);
  assertEquals(q2.dropped.length, 1);
  // stub fixture files must never win a later suite's library query
  q.run("UPDATE broll_assets SET enabled = 0 WHERE id IN ('b-laptop','b-short','b-nature','b-qf')");
});

/* ---------------- creative director merge ---------------- */

function directorInput(): CreativeDirectInput {
  return {
    title: 'Tiga langkah rahasia',
    clipStart: 100,
    clipEnd: 120,
    duration: 20,
    aspect: '9:16',
    sourceAspect: 16 / 9,
    scene: { ...EMPTY_SCENE_ANALYSIS, windowStart: 98, windowEnd: 122, faceCoverage: 0.7 },
    hasHook: true,
    timeline: buildTimeline(100, 120, { start: 104, end: 108 }),
    transcript: [{ start: 100, end: 104, text: 'Banyak orang gagal karena ini.' }],
    words,
    subtitlePlan,
    musicPlan: null,
    hookEnd: 3.8,
  };
}

test('buildBaseline is a valid deterministic EDL', () => {
  const input = directorInput();
  const { edl } = buildBaseline(input);
  const r = validateEdl(edl, creativeContext(input, [], []));
  assert(r.ok && r.edl, `baseline must validate: ${r.errors.join(', ')}`);
});

test('mergeFragment replaces provided arrays only and unwraps nested EDL', () => {
  const input = directorInput();
  const baseline = buildBaseline(input).edl;
  const notes: string[] = [];
  const merged = mergeFragment(
    baseline,
    {
      edl: {
        titles: [{ text: 'Momen penting', start: 0.5, end: 3 }],
        style: { grade: 'vivid' },
      },
    },
    notes
  );
  const r = validateEdl(merged, creativeContext(input, [], []));
  assert(r.ok && r.edl, `merged EDL must validate: ${r.errors.join(', ')}`);
  assertEquals(r.edl!.titles.map((t) => t.text), ['Momen penting']);
  assertEquals(r.edl!.style.grade, 'vivid');
  assertEquals(r.edl!.framings.length, baseline.framings.length, 'omitted framings keep the baseline');
  assertEquals(r.edl!.style.accentColor, baseline.style.accentColor, 'unset style keys keep baseline values');
});

test('mergeFragment drops invalid items and ignores a bad style block', () => {
  const input = directorInput();
  const baseline = buildBaseline(input).edl;
  const notes: string[] = [];
  const merged = mergeFragment(
    baseline,
    {
      style: { grade: 'neon' },
      callouts: [{ text: 'ok', x: 0.5, y: 0.5, start: 2, end: 4 }, { text: '', x: 0.5, y: 0.5, start: 2, end: 4 }],
      broll: 'not-an-array',
    },
    notes
  );
  const r = validateEdl(merged, creativeContext(input, [], []));
  assert(r.ok && r.edl, 'still valid after sanitizing');
  assertEquals(r.edl!.style.grade, baseline.style.grade, 'invalid style block ignored');
  assertEquals(r.edl!.callouts.length, 1, 'invalid callout dropped');
  assert(notes.some((n) => n.includes('callouts')), 'invalid items are reported');
  assert(notes.length >= 2, 'bad style and bad broll array are reported');
});

/* ---------------- render graph: adaptive stages ---------------- */

function graphSpec(extra: Partial<RenderGraphSpec> = {}): RenderGraphSpec {
  return {
    clipStart: 2,
    timeline: buildTimeline(2, 10, null),
    plan: { aspect: '9:16', cropW: 640, cropH: 1080, frames: [{ t: 0, cx: 320 }], usedTracking: false } as ReframePlan,
    size: { w: 270, h: 480 },
    fps: 30,
    assPath: null,
    captionInput: null,
    watermarks: [],
    watermarkInputStart: 1,
    musicInput: null,
    music: null,
    hasAudio: false,
    speechRanges: [],
    voiceTargetLufs: -16,
    voiceTpDb: -1.5,
    truePeakDb: -1,
    creative: null,
    ...extra,
  };
}

test('zoomExprFromKeys builds a piecewise-linear expression and nulls out flat curves', () => {
  assertEquals(zoomExprFromKeys([]), null);
  assertEquals(zoomExprFromKeys([{ t: 0, z: 1 }, { t: 5, z: 1 }]), null);
  const e = zoomExprFromKeys([{ t: 0, z: 1 }, { t: 1, z: 1.24 }, { t: 7, z: 1 }, { t: 8, z: 1 }]);
  assert(e, 'non-flat curve produces an expression');
  assert(e!.includes('if(lt(t\\,1.000)'), 'first boundary guarded');
  assert(e!.includes('\\,'), 'commas are escaped for filter_complex');
});

test('buildRenderGraph applies punch-in, grade and edge fades after concat', () => {
  const g = buildRenderGraph(
    graphSpec({
      creative: {
        zoomKeys: [{ t: 0, z: 1 }, { t: 1, z: 1.24 }, { t: 7, z: 1.24 }, { t: 8, z: 1 }],
        grade: 'warm',
        backgroundFill: 'crop',
        edgeFade: true,
        transition: 'fade',
        audio: { cleanup: true, ducking: true },
      },
      hasAudio: true,
      musicInput: null,
      music: null,
    })
  );
  assert(g.filterComplex.includes('eval=frame'), 'animated scale');
  assert(g.filterComplex.includes('trunc(iw*('), 'zoom width follows the curve');
  assert(g.filterComplex.includes('crop=270:480:(iw-270)/2:(ih-480)/2'), 'zoom crop keeps the frame centered');
  assert(g.filterComplex.includes('eq=brightness='), 'grade eq stage');
  assert(g.filterComplex.includes('colorbalance='), 'grade colorbalance stage');
  assert(g.filterComplex.includes('fade=t=out'), 'edge fade');
  assert(g.filterComplex.indexOf('[vz]') < g.filterComplex.indexOf('eq='), 'zoom before grade');
  assert(g.filterComplex.includes('highpass=f=80'), 'voice cleanup highpass');
  assert(g.filterComplex.includes('afftdn=nr=12:nf=-35'), 'adaptive noise removal');
});

test('buildRenderGraph blur-fill skips the crop and composites a blurred backdrop', () => {
  const g = buildRenderGraph(
    graphSpec({
      creative: { zoomKeys: [{ t: 0, z: 1 }], grade: 'none', backgroundFill: 'fill-blur', edgeFade: false, transition: 'fade' },
    })
  );
  assert(g.filterComplex.includes('gblur=sigma=24'), 'blurred backdrop');
  assert(g.filterComplex.includes('force_original_aspect_ratio=decrease'), 'contain-fit foreground');
  assert(g.filterComplex.includes('[vbg][vfit]overlay='), 'backdrop + foreground composite');
  assert(!g.filterComplex.includes('crop=640:1080'), 'reframe crop skipped for blur-fill');
});

test('buildRenderGraph shifts the pan clock per segment and supports the slide transition', () => {
  const tl = buildTimeline(2, 10, { start: 4, end: 7 });
  const plan: ReframePlan = {
    aspect: '9:16', cropW: 640, cropH: 1080,
    frames: [{ t: 0, cx: 320 }, { t: 5, cx: 500 }], usedTracking: true,
  };
  const g = buildRenderGraph(
    graphSpec({
      timeline: tl,
      plan,
      creative: { zoomKeys: [{ t: 0, z: 1 }], grade: 'none', backgroundFill: 'crop', edgeFade: false, transition: 'slide' },
    })
  );
  assert(g.filterComplex.includes('(t+2.000)'), 'hook segment crop pan uses its source offset');
  assert(g.filterComplex.includes('xfade=transition=slideleft'), 'slide transition mapped to xfade');
});

test('buildRenderGraph composites b-roll cover and pip layers with alpha fades', () => {
  const g = buildRenderGraph(
    graphSpec({
      creative: { zoomKeys: [{ t: 0, z: 1 }], grade: 'none', backgroundFill: 'crop', edgeFade: false, transition: 'fade' },
      broll: [
        { inputIndex: 1, kind: 'video', path: 'b.mp4', start: 1, end: 3, mode: 'cover', position: 'bottom-right', sizePercent: 100 },
        { inputIndex: 2, kind: 'image', path: 'b.png', start: 4, end: 5, mode: 'pip', position: 'top-right', sizePercent: 30 },
      ],
    })
  );
  assert(g.filterComplex.includes('scale=270:480:force_original_aspect_ratio=increase'), 'cover fills the frame');
  assert(g.filterComplex.includes('scale=81:-2'), 'pip scales to sizePercent');
  assert(g.filterComplex.includes('fade=t=in:st=1:d=0.35:alpha=1'), 'clip-window alpha fade in');
  assert(g.filterComplex.includes('fade=t=out:st=2.65:d=0.35:alpha=1'), 'cover alpha fade out');
  assert(g.filterComplex.includes('fade=t=out:st=4.75:d=0.25:alpha=1'), 'pip alpha fade out');
  assert(g.filterComplex.includes("enable='between(t,1,3)'"), 'cover window enable');
  assert(g.filterComplex.includes('main_w-overlay_w-24'), 'pip top-right margin');
  assert(g.filterComplex.includes('[bro0]') && g.filterComplex.includes('[bro1]'), 'layered b-roll chain');
  assert(g.filterComplex.indexOf('[bro0]') < g.filterComplex.indexOf('[bro1]'), 'layers stack in placement order');
});

test('buildRenderArgs indexes b-roll and sfx inputs after caption and wires the mix', () => {
  const args = buildRenderArgs({
    source: 'src.mp4',
    output: 'out.mp4',
    outputDuration: 8,
    rs: getSettings('render'),
    clipStart: 0,
    timeline: buildTimeline(0, 8, null),
    plan: null,
    size: { w: 270, h: 480 },
    fps: 30,
    assPath: null,
    captionPath: 'cap.mov',
    watermarks: [],
    musicPath: null,
    music: null,
    hasAudio: true,
    speechRanges: [],
    voiceTargetLufs: -16,
    voiceTpDb: -1.5,
    truePeakDb: -1,
    broll: [{ kind: 'image', path: 'img.png', start: 1, end: 2, mode: 'cover', position: 'bottom-right', sizePercent: 100 }],
    sfx: [{ path: 's.wav', at: 0.5, volumeDb: 6 }],
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert(args.includes('-loop') && args.includes('img.png'), 'image b-roll gets a looped input');
  assert(args.includes('s.wav'), 'sfx input present');
  assert(fc.includes('[1:v]'), 'b-roll input index after caption');
  assert(fc.includes('adelay=500:all=1') && fc.includes('volume=6dB'), 'sfx delayed and gained');
  assert(fc.includes('amix=inputs=2'), 'voice + sfx mix');
  assert(fc.includes('alimiter=limit='), 'final limiter');
});

test('sfx can carry the mix without any voice or music', () => {
  const g = buildRenderGraph(
    graphSpec({ hasAudio: false, musicInput: null, music: null, sfx: [{ inputIndex: 1, path: 's.wav', at: 0.5, volumeDb: 0 }] })
  );
  assertEquals(g.audioLabel, '[aud]');
  assert(g.filterComplex.includes('adelay=500:all=1'), 'sfx delayed');
  assert(!g.filterComplex.includes('[voice]'), 'no voice chain when the source has no audio');
});

test('planOptionsHash reacts to the creative mode', () => {
  const base = defaultRenderOptions();
  const basic = defaultRenderOptions();
  basic.creative = { mode: 'basic', qualityReview: true };
  assert(planOptionsHash(base, { x: 1 }) !== planOptionsHash(basic, { x: 1 }), 'creative mode must invalidate cached plans');
});

test('buildEditingPlan v4 in basic mode stores no creative EDL and caches by hash', async () => {
  const { q } = await import('../src/lib/sqlite.js');
  q.run("INSERT OR IGNORE INTO projects (id, name, source_path) VALUES ('creative-proj','T','x.mp4')");
  q.run("INSERT OR IGNORE INTO clips (id, project_id, ord, start, end) VALUES ('creative-plan-test','creative-proj',0,0,10)");
  const options = defaultRenderOptions();
  options.hook.enabled = false;
  options.subtitles.enabled = false;
  options.backgroundMusic.enabled = false;
  options.creative = { mode: 'basic', qualityReview: false };
  const input = { clipId: 'creative-plan-test', clipStart: 0, clipEnd: 10, title: 'T', transcript: null, options };
  const plan = await buildEditingPlan(input);
  assertEquals(plan.version, PLAN_VERSION);
  assertEquals(PLAN_VERSION, 4);
  assertEquals(plan.creative, null);
  assertEquals(plan.creativeSource, null);
  const cached = await getOrCreateEditingPlan(input);
  assertEquals(cached.optionsHash, plan.optionsHash, 'same inputs resolve the cached plan');
});

/* ---------------- quality review ---------------- */

const reviewEvents = (start: number, end: number) => [{ start, end, lines: ['x'], words: null, emphasisWords: [] }];

test('reviewCreativeStatic flags graphic/caption collisions and repairs them', () => {
  const style = chooseStyle({
    aspect: '9:16', sourceAspect: 16 / 9, duration: 20,
    scene: { ...EMPTY_SCENE_ANALYSIS, faceCoverage: 0.8 }, hasHook: false, speechRate: 2, hasBrollLibrary: false,
  });
  const edl = buildFallbackEdl({ aspectRatio: '9:16', duration: 20, clipStart: 0, clipEnd: 20, style });
  edl.titles = [{ text: 'Center title', start: 0.5, end: 1.5, position: 'center' }];
  edl.statCards = [{ value: '42', label: 'steps', start: 0.6, end: 1.4, position: 'center' }];
  const review = reviewCreativeStatic({ edl, duration: 20, events: [] });
  assert(!review.ok, 'collision detected');
  const collision = review.problems.find((p) => p.code === 'overlay_collision');
  assert(collision && collision.ids && collision.ids.length === 2, 'problem carries both layout ids');

  const repaired = repairEdl(edl, review.problems);
  assert(repaired.applied.length > 0, 'repair applied');
  const again = reviewCreativeStatic({ edl: repaired.edl, duration: 20, events: [] });
  assert(again.ok, `repaired plan is collision-free (${again.problems.map((p) => p.detail).join('; ')})`);
});

test('reviewCreativeStatic flags out-of-range subtitle events and placements', () => {
  const style = chooseStyle({
    aspect: '9:16', sourceAspect: 16 / 9, duration: 6,
    scene: { ...EMPTY_SCENE_ANALYSIS }, hasHook: false, speechRate: 1, hasBrollLibrary: false,
  });
  const edl = buildFallbackEdl({ aspectRatio: '9:16', duration: 6, clipStart: 0, clipEnd: 6, style });
  edl.broll = [{ assetId: 'x', query: null, start: 5.5, end: 7, mode: 'cover', position: 'bottom-right', sizePercent: 34 }];
  edl.sfx = [{ libraryId: 's', at: 6, volumeDb: -6 }];
  const review = reviewCreativeStatic({ edl, duration: 6, events: reviewEvents(5.8, 7.2) });
  assert(!review.ok, 'problems detected');
  assert(review.problems.some((p) => p.code === 'broll_window'), 'b-roll window flagged');
  assert(review.problems.some((p) => p.code === 'audio_clipping'), 'sfx clipping the end flagged');
  assert(review.problems.some((p) => p.code === 'timing'), 'subtitle timing flagged');
});

test('reviewOutputMedia detects an all-black encode and accepts a normal one', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const os = await import('node:os');
  const base = mkdtempSync(join(os.tmpdir(), 'avc-qr-'));
  const blackFile = join(base, 'black.mp4');
  const colorFile = join(base, 'color.mp4');
  const mk = (file: string, spec: string) =>
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', spec, '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
  assert(mk(blackFile, 'color=c=black:s=320x180:r=30').status === 0, 'black fixture');
  assert(mk(colorFile, 'testsrc=size=320x180:rate=30').status === 0, 'color fixture');
  const black = await reviewOutputMedia(blackFile, 4);
  assert(!black.ok && black.problems.some((p) => p.code === 'black_frames'), 'black output flagged');
  const color = await reviewOutputMedia(colorFile, 4);
  assert(color.ok, `normal output passes (${color.problems.map((p) => p.detail).join('; ')})`);
});
