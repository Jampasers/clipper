/* Unit tests for pure logic: scoring, dedup, boundaries, subtitles, tools, prompts */
import { test, assert, assertEquals, assertThrows } from './runner.js';
import { combineScores, deduplicate, overlapRatio, normalizeWeights, lengthFitness } from '../src/services/analysis.js';
import { snapStart, snapEnd, removeFirstSentence } from '../src/services/boundary.js';
import { wrapText, eventsToSrt, buildSubtitleEvents, withEmphasis, eventsToAss } from '../src/services/subtitles.js';
import { validateEditOps, validateToolCall, isToolName } from '../src/lib/tools.js';
import { renderPrompt, promptVariables, DEFAULT_PROMPTS } from '../src/lib/prompts.js';
import { extractJson } from '../src/lib/ai.js';
import { buildFfmpegArgs } from '../src/services/render.js';
import { smoothTrack, aspectSize } from '../src/services/reframe.js';
import type { TranscriptSegment } from '../src/services/transcribe.js';
import { getSettings } from '../src/lib/settings.js';
import { layoutEvent, type CaptionEvent } from '../remotion/word-state.js';
import { initDb, q } from '../src/lib/sqlite.js';
import { enqueue, getJob, recoverOrphanedJobs } from '../src/lib/queue.js';

// settings need a DB
initDb();

const segs: TranscriptSegment[] = [
  { start: 0, end: 4, text: 'Hello there. This is a test.' },
  { start: 4.5, end: 9, text: 'We are talking about boundaries.' },
  { start: 10, end: 15, text: 'Here is a great punchline!' },
  { start: 16, end: 20, text: 'Short.' },
];

/* ---------- overfitting-free scoring ---------- */
test('combineScores weights factors and is normalized 0-100', () => {
  const r = combineScores({ hook: 10, payoff: 10, emotion: 5, standalone: 5, curiosity: 5, shareability: 5, context: 5, entertainment: 5 }, 45);
  assert(r.overall_score > 0 && r.overall_score <= 100, 'overall in range');
  assert(r.overall_score > 60, 'a perfect hook+payoff should score well');
});
test('normalizeWeights always sums to 100', () => {
  const w = normalizeWeights({ hook: 2, payoff: 2, emotion: 1, standalone: 1, curiosity: 1, shareability: 1, context: 1, entertainment: 1, length: 0 });
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 100) < 0.01, 'sums to 100');
});
test('lengthFitness peaks within window', () => {
  assert(lengthFitness(45, 20, 45, 90) === 10, 'target = 10');
  assert(lengthFitness(10, 20, 45, 90) < 6, 'too short scores low');
  assert(lengthFitness(120, 20, 45, 90) < 10, 'too long penalized');
});

/* ---------- dedup ---------- */
test('overlapRatio measures intersection/min-length', () => {
  assertEquals(overlapRatio({ start: 0, end: 10 }, { start: 5, end: 15 }), 0.5);
  assertEquals(overlapRatio({ start: 0, end: 10 }, { start: 20, end: 30 }), 0);
  assertEquals(overlapRatio({ start: 0, end: 10 }, { start: 2, end: 8 }), 1);
});
test('deduplicate keeps the higher-scoring of overlapping clips', () => {
  const out = deduplicate(
    [
      { start: 0, end: 40, overall_score: 50 },
      { start: 5, end: 45, overall_score: 90 },
      { start: 100, end: 140, overall_score: 70 },
    ],
    0.5
  );
  assertEquals(out.length, 2);
  assertEquals(out[0].overall_score, 90);
});

/* ---------- boundaries ---------- */
test('snapStart/End move to nearest sentence boundary within window', () => {
  assertEquals(snapStart(segs, 4.1), 4.5);
  assertEquals(snapEnd(segs, 9.2), 9);
  assertEquals(snapStart(segs, 0.2), 0.2, 'already a segment start, stays put');
  assertEquals(snapStart(segs, 12), 12, 'no segment start nearby, unchanged');
});
test('removeFirstSentence advances to next segment start', () => {
  assertEquals(removeFirstSentence(segs, 0), 4.5);
});

/* ---------- subtitles ---------- */
test('wrapText obeys char/word/line limits', () => {
  const lines = wrapText('one two three four five six seven eight', 12, 3, 2);
  assert(lines.length <= 2, 'max lines respected');
  // all but the final merged line respect the word cap
  for (let i = 0; i < lines.length - 1; i++) assert(lines[i].split(/\s+/).length <= 3, `line ${i} <= 3 words`);
});
test('buildSubtitleEvents clips to window and is clip-relative', () => {
  const preset = getSettings('subtitles').presets.classic;
  const ev = buildSubtitleEvents(segs, 4, 15, preset);
  assert(ev.length >= 1, 'has events');
  for (const e of ev) assert(e.start >= 0 && e.end <= 11.01, 'relative timestamps');
});
test('eventsToSrt produces valid SRT blocks', () => {
  const preset = getSettings('subtitles').presets.classic;
  const srt = eventsToSrt(buildSubtitleEvents(segs, 0, 15, preset));
  assert(/1\n00:00:0\d,\d{3} --> /.test(srt), 'srt numbering + timestamps');
});
test('emphasis tagging marks target words', () => {
  const preset = getSettings('subtitles').presets.bold;
  const ev = withEmphasis(buildSubtitleEvents(segs, 0, 15, preset), ['test', 'PUNCHLINE']);
  const tagged = ev.filter((e) => e.emphasisWords.length > 0);
  assert(tagged.length >= 1, 'emphasis attached');
});
test('eventsToAss emits a valid header + dialogue', () => {
  const preset = getSettings('subtitles').presets.bold;
  const ass = eventsToAss(buildSubtitleEvents(segs, 0, 15, preset), preset, 1080, 1920);
  assert(ass.includes('[Script Info]') && ass.includes('Dialogue:'), 'ass structure');
});
test('layoutEvent assigns word timing and emphasis to the wrapped words', () => {
  const ev: CaptionEvent = {
    start: 0.5, end: 2.5, lines: ['Hello there friend', 'wow'],
    words: [
      { text: 'Hello', start: 0.5, end: 0.9 },
      { text: 'there', start: 0.9, end: 1.3 },
      { text: 'friend', start: 1.3, end: 1.8 },
      { text: 'wow', start: 1.8, end: 2.3 },
    ],
    emphasisWords: ['FRIEND!'],
  };
  const laid = layoutEvent(ev, true);
  assertEquals(laid.lines[0][2].text, 'friend');
  assertEquals(laid.lines[0][2].emphasis, true);
  assertEquals(laid.lines[0][0].emphasis, false);
  assert(Math.abs(laid.lines[1][0].start - 1.8) < 1e-6, 'wow keeps its timing');
});
test('layoutEvent synthesizes even timing when word timings are missing', () => {
  const laid = layoutEvent({ start: 0, end: 2, lines: ['a b'], words: null, emphasisWords: [] }, false);
  assertEquals(laid.lines[0].length, 2);
  assertEquals(laid.lines[0][0].start, 0);
  assertEquals(laid.lines[0][1].start, 1);
});

/* ---------- controlled tools ---------- */
test('edit ops are strictly validated', () => {
  const good = validateEditOps([{ kind: 'shift_start', delta: -5 }, { kind: 'set_aspect', aspect: '9:16' }]);
  assert(good.ok, 'valid ops pass');
  const bad = validateEditOps([{ kind: 'rm -rf /' }]);
  assert(!bad.ok, 'unknown op rejected');
  const bad2 = validateEditOps([{ kind: 'shift_start', delta: 9999 }]);
  assert(!bad2.ok, 'out-of-range rejected');
});
test('no shell/exec tool can ever be selected', () => {
  assert(!isToolName('exec'), 'exec not allowed');
  assert(!isToolName('shell'), 'shell not allowed');
  const r = validateToolCall('rm', { path: '/' });
  assert(!r.ok, 'arbitrary tool rejected');
  const ok = validateToolCall('probe_video', { project_id: 'abc' });
  assert(ok.ok, 'declared tool accepted');
});

/* ---------- prompts ---------- */
test('prompts render template variables and expose them', () => {
  const t = 'Video {{duration}}s for {{platform}}';
  assertEquals(renderPrompt(t, { duration: 120, platform: 'tiktok' }), 'Video 120s for tiktok');
  assertEquals(promptVariables(t), ['duration', 'platform']);
  assert(DEFAULT_PROMPTS.highlight_detection.includes('{{transcript}}'), 'default prompt has transcript var');
});

/* ---------- queue recovery ---------- */
test('recoverOrphanedJobs requeues jobs left running by a crashed process', () => {
  const id = enqueue('probe', {});
  q.run("UPDATE jobs SET status = 'running', started_at = datetime('now') WHERE id = ?", id);
  assert(recoverOrphanedJobs() >= 1, 'reports at least one recovered job');
  assertEquals(getJob(id)!.status, 'queued');
});

/* ---------- render config ---------- */
test('buildFfmpegArgs encodes the intended settings deterministically', () => {
  const rs = getSettings('render');
  const args = buildFfmpegArgs({
    source: 'in.mp4', start: 10, duration: 30, filters: 'crop=1:2:3:0,fps=30,scale=1080:1920', rs, hasAudio: true, output: 'out.mp4',
  });
  const s = args.join(' ');
  assert(s.includes('-ss') && s.includes('-crf'), 'has seek + crf');
  assert(s.includes('scale=1080:1920'), 'scales to target via -vf');
  assert(args.includes('-c:a') && args.includes('-b:a'), 'audio codec + bitrate set');
  assert(s.includes('-movflags +faststart'), 'faststart for streaming');
  assertEquals(args[args.length - 1], 'out.mp4', 'output is last');
});
test('buildFfmpegArgs composites the caption overlay instead of burning ass', () => {
  const rs = getSettings('render');
  const args = buildFfmpegArgs({
    source: 'in.mp4', start: 10, duration: 30,
    filters: 'fps=30,scale=1080:1920,setsar=1',
    overlayPath: 'C:/t/caption.mov', rs, hasAudio: true, output: 'out.mp4',
  });
  const s = args.join(' ');
  assert(args.includes('C:/t/caption.mov'), 'overlay is the second input');
  assert(s.includes('overlay=0:0:format=auto'), 'overlay filter present');
  assert(s.includes('-map [v]'), 'filtered video mapped');
  assert(!args.includes('-vf'), 'no single-input vf when overlaying');
});

/* ---------- reframe ---------- */
test('aspectSize computes correct dimensions', () => {
  assertEquals(aspectSize('9:16', 1920), { w: 1080, h: 1920 });
  assertEquals(aspectSize('1:1', 1920), { w: 1920, h: 1920 });
});
test('smoothTrack rate-limits motion and applies deadzone', () => {
  const pts = [
    { t: 0, cx: 100 }, { t: 1, cx: 900 }, { t: 2, cx: 900 },
  ];
  const frames = smoothTrack(pts, { window: 1, maxSpeed: 100, deadzone: 0, fallbackCx: 100, startT: 0, endT: 3 });
  const jump = frames[1].cx - frames[0].cx;
  assert(Math.abs(jump) <= 100.5, `pan limited to maxSpeed, got ${jump}`);
});

test('extractJson recovers truncated JSON by closing brackets', () => {
  const raw = '```json\n{"moments":[{"t":1,"label":"intro"},{"t":20,"label":"';
  const r = extractJson<{ moments: { t: number; label?: string }[] }>(raw);
  assert(Array.isArray(r.moments), 'moment array recovered');
  assertEquals(r.moments[0].label, 'intro');
});
test('extractJson recovers an object cut at a dangling key', () => {
  const r = extractJson<Record<string, number>>('{"hook": 2, "context": 2, "standalone": 3, "emotion": 2, "entertainment":');
  assertEquals(r.hook, 2);
  assertEquals(r.standalone, 3);
});
test('extractJson throws on empty response', () => {
  assertThrows(() => extractJson(''));
});

export {};
