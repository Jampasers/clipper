/* Pure-logic tests for the AI editing upgrade: timeline, hook, subtitle plan,
 * music fallback, render graph, SVG sanitization, watermark layers, loudness QA. */
import { test, assert, assertEquals, assertThrows } from './runner.js';
import fs from 'node:fs';
import { initDb, q } from '../src/lib/sqlite.js';
import {
  buildTimeline, mapSourceToOutput, mapOutputToSource, isHookSpanValid,
} from '../src/services/timeline.js';
import {
  collectClipWords, fallbackSubtitlePlan, normalizeSubtitlePlan, resolveWordStyles, annotateTranscript,
  resolveWordVisual,
} from '../src/services/subtitle-plan.js';
import { buildTimelineSubtitleEvents } from '../src/services/subtitles.js';
import { validateHookCandidates, fallbackHookCandidates, pickHook } from '../src/services/hook.js';
import {
  buildRenderGraph, buildRenderArgs, watermarkPosExpr, mergeSpeechRanges, duckEnableExpr,
  escapeSubtitlePath,
} from '../src/services/render-graph.js';
import { planOptionsHash, defaultRenderOptions } from '../src/services/render-options.js';
import { parseLoudness } from '../src/services/render.js';
import { buildSpeechRanges } from '../src/services/render.js';
import { sanitizeSvg, svgDimensions, safeExtension, resolveWatermarkLayers } from '../src/services/assets.js';
import { fallbackMusicPick } from '../src/services/music.js';
import { getSettings } from '../src/lib/settings.js';
import type { TranscriptSegment } from '../src/services/transcribe.js';

initDb();

const segments: TranscriptSegment[] = [
  { start: 10, end: 14, text: 'Banyak orang gagal karena ini.', words: [
    { start: 10, end: 10.4, word: 'Banyak' }, { start: 10.4, end: 10.9, word: 'orang' },
    { start: 10.9, end: 11.5, word: 'gagal' }, { start: 11.6, end: 12.0, word: 'karena' },
    { start: 12.0, end: 12.4, word: 'ini.' },
  ] },
  { start: 14.2, end: 18, text: 'Rahasianya cuma 3 langkah sederhana!', words: [
    { start: 14.2, end: 14.8, word: 'Rahasia' }, { start: 14.9, end: 15.3, word: 'cuma' },
    { start: 15.4, end: 15.9, word: '3' }, { start: 16.0, end: 16.6, word: 'langkah' },
    { start: 16.7, end: 17.2, word: 'sederhana!' },
  ] },
  { start: 18.4, end: 22, text: 'Coba sekarang sebelum terlambat?' },
];

/* ---------- timeline ---------- */

test('buildTimeline without hook is a single main segment', () => {
  const tl = buildTimeline(10, 22, null);
  assertEquals(tl.segments.length, 1);
  assertEquals(tl.segments[0].role, 'main');
  assertEquals(tl.outputDuration, 12);
  assertEquals(tl.hook, null);
});

test('buildTimeline copies a valid hook to the front; main clip stays complete', () => {
  const tl = buildTimeline(10, 22, { start: 14.2, end: 18 });
  assertEquals(tl.segments.map((s) => s.role), ['hook', 'main']);
  assertEquals(tl.outputDuration, 15.3, 'clip + hook teaser - crossfade overlap');
  assertEquals(tl.segments[0].sourceStart, 14.2);
  assertEquals(tl.segments[0].sourceEnd, 18);
  assertEquals(tl.segments[1].sourceStart, 10, 'main starts at the clip start');
  assertEquals(tl.segments[1].sourceEnd, 22, 'main keeps the hook span inside');
  assertEquals(round3(tl.segments[0].outputEnd - tl.segments[1].outputStart), 0.5, 'crossfade overlap');
});

test('isHookSpanValid rejects spans outside the clip or covering everything', () => {
  assert(!isHookSpanValid({ start: 5, end: 10 }, 10, 22), 'outside');
  assert(!isHookSpanValid({ start: 10, end: 11 }, 10, 22), 'too short');
  assert(!isHookSpanValid({ start: 10, end: 21.5 }, 10, 22), 'covers whole clip');
  assert(isHookSpanValid({ start: 14, end: 18 }, 10, 22), 'valid');
});

test('mapSourceToOutput/mapOutputToSource roundtrip across the hook reorder', () => {
  const tl = buildTimeline(10, 22, { start: 14.2, end: 18 });
  // source 15.0s now lives at the very front (hook segment)
  assertEquals(round3(mapSourceToOutput(tl, 15.0)!), round3(15.0 - 14.2));
  // source 12.0s follows the hook (main output starts 3.3s, after the crossfade)
  assertEquals(round3(mapSourceToOutput(tl, 12.0)!), round3(3.3 + (12.0 - 10)));
  // output 1.0s maps back into the hook span
  assertEquals(round3(mapOutputToSource(tl, 1.0)!), round3(14.2 + 1.0));
  // a source time outside the clip is not on the timeline
  assertEquals(mapSourceToOutput(tl, 30), null);
});

/* ---------- subtitle plan ---------- */

test('collectClipWords keeps word timing and synthesizes it when absent', () => {
  const words = collectClipWords(segments, 10, 22);
  assert(words.length > 5, 'collects words');
  assertEquals(words.find((w) => w.text === '3')?.start, 15.4);
  const synth = collectClipWords([{ start: 10, end: 12, text: 'satu dua tiga' }], 10, 12);
  assertEquals(synth.map((w) => w.text), ['satu', 'dua', 'tiga']);
  assert(synth[2].end - synth[2].start > 0, 'synthetic word spans have duration');
});

test('fallbackSubtitlePlan emphasizes numbers deterministically, never the whole sentence', () => {
  const words = collectClipWords(segments, 10, 22);
  const plan = fallbackSubtitlePlan(words);
  assert(plan.length > 0, 'picks something');
  assert(plan.length <= Math.max(2, Math.min(40, Math.ceil(words.length * 0.2))), 'respects cap');
  const idx = words.find((w) => w.text === '3')!.index;
  assert(plan.some((p) => p.index === idx && p.role === 'number'), 'number word highlighted');
});

test('normalizeSubtitlePlan drops unknown indexes, invalid roles and caps length', () => {
  const words = collectClipWords(segments, 10, 22);
  const raw = { words: [
    { index: 999, role: 'important' },
    { index: words[0].index, role: 'important', color: '#00FF00', scale: 1.6 },
    { index: words[1].index, role: 'normal' },
    { index: words[2].index, role: 'number', animation: 'bounce', priority: 9 },
  ] };
  const plan = normalizeSubtitlePlan(raw, words);
  assertEquals(plan.map((p) => p.index), [words[0].index, words[2].index]);
  assertEquals(plan[0].color, '#00FF00', 'valid color kept');
});
test('normalizeSubtitlePlan rejects whole payloads with invalid fields', () => {
  const words = collectClipWords(segments, 10, 22);
  const raw = { words: [{ index: words[0].index, role: 'important', color: 'not-a-hex' }] };
  assertEquals(normalizeSubtitlePlan(raw, words), []);
});

test('resolveWordStyles honors style mode and animations flag', () => {
  const words = collectClipWords(segments, 10, 22);
  const plan = fallbackSubtitlePlan(words);
  const ctx = { style: 'ai' as const, aiHighlight: true, animations: false };
  const off = resolveWordStyles(plan, ctx);
  assert([...off.values()].every((s) => s.animation === 'none'), 'animations disabled');
  const karaoke = resolveWordStyles(plan, { ...ctx, style: 'karaoke' });
  assertEquals(karaoke.size, 0, 'karaoke leaves emphasis to the active word');
  const on = resolveWordStyles(plan, { ...ctx, animations: true });
  assert([...on.values()].some((s) => s.animation !== 'none'), 'animations enabled');
});

test('annotateTranscript attaches styles to matched words only', () => {
  const words = collectClipWords(segments, 10, 18); // real word timing only
  const plan = fallbackSubtitlePlan(words);
  assert(plan.length > 0, 'plan has picks');
  const styles = resolveWordStyles(plan, { style: 'ai', aiHighlight: true, animations: true });
  const annotated = annotateTranscript(segments, words, styles);
  const styled = annotated.flatMap((s) => s.words ?? []).filter((w) => w.style);
  assertEquals(styled.length, styles.size);
});

test('buildTimelineSubtitleEvents shifts events to output time and carries styles', () => {
  const tl = buildTimeline(10, 22, { start: 14.2, end: 18 });
  const words = collectClipWords(segments, 10, 22);
  const styles = resolveWordStyles(fallbackSubtitlePlan(words), { style: 'ai', aiHighlight: true, animations: true });
  const annotated = annotateTranscript(segments, words, styles);
  const events = buildTimelineSubtitleEvents(annotated, tl, Object.values(getSettings('subtitles').presets)[0]);
  assert(events.length >= 3, 'one event per timeline/source overlap');
  for (let i = 1; i < events.length; i++) {
    assert(events[i].start >= events[i - 1].start, 'sorted');
    assert(events[i].start >= events[i - 1].end - 0.001, 'never overlaps');
  }
  const first = events[0];
  assert(first.start < 0.01 && first.end <= 4.1, 'hook event starts at zero');
  assert(events.some((e) => (e.words ?? []).some((w) => w.style)), 'styles survive the timeline mapping');
});

/* ---------- hook ---------- */

test('validateHookCandidates snaps to word indexes and rejects invalid spans', () => {
  const words = collectClipWords(segments, 10, 22);
  const raw = { candidates: [
    { start_word: 0, end_word: 1, score: 50, reason: 'too short' },
    { start_word: 5, end_word: 9, score: 80, reason: 'good' },
    { start_word: 900, end_word: 905, score: 99 },
  ] };
  const c = validateHookCandidates(raw, words, 10, 22, 3, 8);
  assertEquals(c.length, 1);
  assertEquals(c[0].start, words[5].start);
  assertEquals(c[0].end, words[9].end);
});

test('fallbackHookCandidates finds a marker sentence inside the clip', () => {
  const words = collectClipWords(segments, 10, 22);
  const c = fallbackHookCandidates(words, 10, 22, 3.5, 2, 8);
  assert(c.length > 0, 'produces candidates');
  assert(pickHook(c, 10, 22, 2, 8) !== null, 'at least one candidate is usable');
});

/* ---------- render graph ---------- */

const baseGraph = {
  clipStart: 10,
  plan: null,
  size: { w: 1080, h: 1920 },
  fps: 30,
  assPath: null,
  captionInput: null,
  watermarks: [],
  watermarkInputStart: 1,
  musicInput: null,
  music: null,
  hasAudio: true,
  speechRanges: [],
  voiceTargetLufs: -16,
  voiceTpDb: -1.5,
  truePeakDb: -1,
};

test('buildRenderGraph single segment: fps/scale, voice loudnorm, no BGM', () => {
  const g = buildRenderGraph({ ...baseGraph, timeline: buildTimeline(10, 22, null) });
  assert(g.filterComplex.includes('fps=30'), 'fps set');
  assert(g.filterComplex.includes('scale=1080:1920'), 'output scale');
  assert(g.filterComplex.includes('loudnorm=I=-16'), 'voice normalized');
  assert(!g.filterComplex.includes('amix'), 'no mixer without music');
  assertEquals(g.audioLabel, '[aud]');
});

test('buildRenderGraph hook timeline: crossfade between hook teaser and full main input', () => {
  const g = buildRenderGraph({ ...baseGraph, timeline: buildTimeline(10, 22, { start: 14.2, end: 18 }) });
  assert(!g.filterComplex.includes('split='), 'no giant split buffering');
  assert(!g.filterComplex.includes('trim='), 'inputs are pre-trimmed by -ss/-t');
  assert(g.filterComplex.includes('[0:v]'), 'hook teaser is input 0');
  assert(g.filterComplex.includes('[1:v]'), 'full main clip is input 1');
  assert(g.filterComplex.includes('xfade=transition=fade:duration=0.5:offset=3.3'), 'crossfade at the boundary');
  assert(g.filterComplex.includes('acrossfade=d=0.5'), 'audio crossfades too');
  assert(!g.filterComplex.includes('concat='), 'no hard cut in the hook case');
});

test('buildRenderGraph ducks music during speech with enable expression', () => {
  const g = buildRenderGraph({
    ...baseGraph,
    timeline: buildTimeline(10, 22, null),
    musicInput: 1,
    music: { inputIndex: 1, volumeDb: -2, duckDb: 6, voiceDucking: true, fadeIn: 0.5, fadeOut: 1, targetLufs: -17, duration: 12 },
    speechRanges: [{ start: 0, end: 2 }, { start: 2.6, end: 4 }],
  });
  assert(g.filterComplex.includes('volume=-2dB'), 'volume offset applied');
  assert(/volume=0\.50\d*:enable='between\(t,0,2\)\+between\(t,2\.6,4\)'/.test(g.filterComplex), `enable ducking expr (${g.filterComplex})`);
  assert(g.filterComplex.includes('amix=inputs=2'), 'mixes voice + music');
  assert(g.filterComplex.includes('alimiter'), 'limits true peak');
});

test('buildRenderGraph overlays watermarks with scaled width and position', () => {
  const wm = { asset: { id: 'w1', file_path: 'wm.png' } as never, position: 'bottom-right' as const, x: null, y: null, widthPercent: 20, opacity: 0.5, margin: 30 };
  const g = buildRenderGraph({ ...baseGraph, timeline: buildTimeline(10, 22, null), watermarks: [wm], captionInput: 2 });
  assert(g.filterComplex.includes('scale=216:-1'), 'watermark width = 20% of 1080');
  assert(g.filterComplex.includes('colorchannelmixer=aa=0.5'), 'opacity');
  assert(g.filterComplex.includes("x='main_w-overlay_w-30'"), 'bottom-right x');
  assert(g.filterComplex.includes('[2:v]overlay=0:0'), 'caption overlay input index respected');
});

test('buildRenderArgs indexes inputs watermark -> music -> caption', () => {
  const wm = { asset: { id: 'w1', file_path: 'wm.png' } as never, position: 'top-left' as const, x: null, y: null, widthPercent: 10, opacity: 1, margin: 10 };
  const args = buildRenderArgs({
    ...baseGraph,
    timeline: buildTimeline(10, 22, null),
    source: 'in.mp4',
    output: 'out.mp4',
    outputDuration: 12,
    rs: getSettings('render'),
    watermarks: [wm],
    musicPath: 'bgm.mp3',
    captionPath: 'cap.mov',
    music: { inputIndex: -1, volumeDb: 0, duckDb: 6, voiceDucking: true, fadeIn: 0, fadeOut: 0, targetLufs: -17, duration: 12 },
  });
  const idx = (v: string) => args.indexOf(v);
  assert(idx('-stream_loop') > 0 && idx('bgm.mp3') > idx('-i'), 'music input loops');
  const fc = args[idx('-filter_complex') + 1];
  assert(fc.includes('[1:v]scale='), 'watermark is input 1');
  assert(fc.includes('[2:a]atrim'), 'music is input 2');
  assert(fc.includes('[3:v]overlay=0:0'), 'caption is input 3');
  assert(args.includes('-map') && args[idx('-map') + 1] === '[vout]' || args[idx('-map') + 1].startsWith('['), 'maps composed video');
});

test('buildRenderArgs seeks one input per timeline segment and shifts overlay input indexes', () => {
  const wm = { asset: { id: 'w1', file_path: 'wm.png' } as never, position: 'top-left' as const, x: null, y: null, widthPercent: 10, opacity: 1, margin: 10 };
  const args = buildRenderArgs({
    ...baseGraph,
    timeline: buildTimeline(10, 22, { start: 14.2, end: 18 }),
    source: 'in.mp4',
    output: 'out.mp4',
    outputDuration: 12,
    rs: getSettings('render'),
    watermarks: [wm],
    musicPath: null,
    captionPath: null,
    music: null,
  });
  assertEquals(args.filter((a) => a === '-ss').length, 2, 'one seek per segment (hook copy + main)');
  assertEquals(args.filter((a) => a === '-t').length, 3, '2 per-segment durations + output limit');
  assertEquals(args.filter((a) => a === '-i').length, 3, '2 segments + 1 watermark');
  assert(args.includes('14.200') && args.includes('3.800'), 'hook teaser seek/duration');
  assert(args.includes('10.000') && args.includes('12.000'), 'full main clip seek/duration');
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert(fc.includes('[2:v]scale='), 'watermark input shifted after 2 segments');
});

test('mergeSpeechRanges merges close windows, drops tiny ones, clamps to duration', () => {
  const r = mergeSpeechRanges([{ start: 0, end: 1 }, { start: 1.2, end: 2 }, { start: 5, end: 5.1 }, { start: 11, end: 20 }], 12);
  assertEquals(r, [{ start: 0, end: 2 }, { start: 11, end: 12 }]);
  assertEquals(duckEnableExpr(r), 'between(t,0,2)+between(t,11,12)');
});

test('watermarkPosExpr covers every position and clamps custom coordinates', () => {
  assertEquals(watermarkPosExpr('top-left', 20), { x: '20', y: '20' });
  assertEquals(watermarkPosExpr('center', 20), { x: '(main_w-overlay_w)/2', y: '(main_h-overlay_h)/2' });
  const custom = watermarkPosExpr('custom', 0, { x: -10, y: 50 });
  assert(custom.x.includes('max(0') && custom.y.includes('50'), 'custom clamped');
});

test('escapeSubtitlePath escapes windows drive colons and quotes', () => {
  assertEquals(escapeSubtitlePath("C:\\tmp\\it's.ass"), "C\\:/tmp/it\\'s.ass");
});

/* ---------- options hash ---------- */

test('planOptionsHash ignores cosmetic options and reacts to creative ones', () => {
  const a = defaultRenderOptions();
  const b = structuredClone(a);
  (b.watermark as Record<string, unknown>).opacity = 9; // not part of plan hash
  b.backgroundMusic.volumeDb = 5;
  assertEquals(planOptionsHash(a), planOptionsHash(b), 'mix cosmetics do not rebuild the plan');
  const c = structuredClone(a);
  c.hook.duration = 9;
  assert(planOptionsHash(a) !== planOptionsHash(c), 'hook duration changes the plan');
});

/* ---------- music fallback ---------- */

test('fallbackMusicPick prefers keyword overlap, single asset always wins', () => {
  const lib = [
    { id: 'a', name: 'Calm', mood: 'relaxed', genre: 'lofi', energy: 2 },
    { id: 'b', name: 'Fire', mood: 'dramatic', genre: 'cinematic', energy: 5 },
  ] as never[];
  assertEquals(fallbackMusicPick('a dramatic cinematic story', lib)?.asset.id, 'b');
  assertEquals(fallbackMusicPick('nothing relevant here', lib), null);
  assertEquals(fallbackMusicPick('nothing relevant here', [lib[0]])?.asset.id, 'a');
  assertEquals(fallbackMusicPick('anything', []), null);
});

/* ---------- SVG + uploads ---------- */

test('sanitizeSvg accepts clean svg, rejects scripts, handlers and external refs', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>';
  assertEquals(sanitizeSvg(ok), ok);
  assertThrows(() => sanitizeSvg('<svg><script>alert(1)</script></svg>'));
  assertThrows(() => sanitizeSvg('<svg><image href="https://evil/x.png"/></svg>'));
  assertThrows(() => sanitizeSvg('<svg onload="alert(1)"></svg>'));
  assertThrows(() => sanitizeSvg('not an svg'));
});

test('svgDimensions uses viewBox when width/height are missing and caps size', () => {
  assertEquals(svgDimensions('<svg viewBox="0 0 200 100"></svg>'), { width: 200, height: 100 });
  const big = svgDimensions('<svg width="5000" height="5000"></svg>');
  assert(big.width <= 1024 && big.height <= 1024, 'capped');
  assertEquals(svgDimensions('<svg></svg>'), { width: 512, height: 512 });
});

test('safeExtension rejects unsupported types regardless of path tricks', () => {
  assertEquals(safeExtension('LOGO.PNG', new Set(['.png'])), '.png');
  assertThrows(() => safeExtension('logo.exe', new Set(['.png'])));
  assertThrows(() => safeExtension('noext', new Set(['.png'])));
});

/* ---------- watermark layers (DB-backed) ---------- */

test('resolveWatermarkLayers applies per-render overrides without touching rows', () => {
  const wmPath = `${process.env.TEMP}/wtest.png`.replace(/\\/g, '/');
  // real 1x1 PNG: this row can be picked by other suites' "all enabled" resolution
  fs.writeFileSync(wmPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  q.run(
    `INSERT INTO watermarks (id, name, file_path, source_path, mime, width, height, enabled, default_position, width_percent, opacity, margin, x, y)
     VALUES ('wtest','Test',?,NULL,'image/png',10,10,1,'bottom-right',18,0.85,36,NULL,NULL)`,
    wmPath
  );
  const all = resolveWatermarkLayers({ enabled: true, ids: [] });
  assert(all.length >= 1, 'picks enabled watermarks');
  const ov = resolveWatermarkLayers({ enabled: true, ids: ['wtest'], overrides: { wtest: { position: 'center', widthPercent: 30 } } });
  assertEquals(ov.length, 1);
  assertEquals(ov[0].position, 'center');
  assertEquals(ov[0].widthPercent, 30);
  assertEquals(ov[0].asset.width_percent, 18, 'global row untouched');
  assertEquals(resolveWatermarkLayers({ enabled: true, ids: ['missing'] }).length, 0, 'unknown ids skipped');
});

/* ---------- loudness QA parsing ---------- */

test('parseLoudness reads the final ebur128 summary', () => {
  const stderr = [
    'I: -70.0 LUFS', 'Peak: -70.0 dBFS',
    'Summary:', '  Integrated loudness:', '    I:         -16.3 LUFS', '    Threshold: -26.5 LUFS',
    '  True peak:', '    Peak:       -2.8 dBFS',
  ].join('\n');
  assertEquals(parseLoudness(stderr), { integrated: -16.3, truePeak: -2.8 });
  assertEquals(parseLoudness('garbage'), null);
});

/* ---------- speech ranges for ducking ---------- */

test('buildSpeechRanges maps transcript windows onto output time, incl. the hook teaser copy', () => {
  const tl = buildTimeline(10, 22, { start: 14.2, end: 18 });
  const segs: TranscriptSegment[] = [{ start: 9, end: 10.6, text: 'x' }, { start: 17.5, end: 18.5, text: 'y' }];
  const ranges = buildSpeechRanges(segs, tl).map((r) => ({ start: round3(r.start), end: round3(r.end) }));
  assertEquals(ranges, [
    { start: 3.3, end: 3.9 },
    { start: 3.3, end: 3.8 },
    { start: 10.8, end: 11.8 },
  ]);
});

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
