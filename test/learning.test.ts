/* Learning engine + reference retrieval unit tests (deterministic, no network). */
import { test, assert, assertEquals } from './runner.js';
import { initDb, q } from '../src/lib/sqlite.js';
import { setSettings } from '../src/lib/settings.js';
import {
  buildStyleProfile, EMPTY_MEASUREMENTS, STYLE_PROFILE_SCHEMA, overallConfidence,
  tierFromCutCpm, tierFromLoudnessRange, tierRank, rankToTier,
  type ReferenceMeasurements,
} from '../src/services/style-profile.js';
import {
  detectContextKey, normalizeFeatureValue, recordLearningEvent, runLearningUpdate, resolvePreferences,
  setManualPreference, listPreferences, deletePreference, createPreferenceSnapshot, restoreSnapshot,
  resetPreferences, learningFingerprint, aggregateGroup, maybeEnqueueLearningUpdate, updatePreference,
  type LearningEventRow, type PreferenceFeature,
} from '../src/services/learning.js';
import {
  scoreReference, sceneTierTarget, selectRelevantFeatures, tokenize, buildConstraints, buildVisualLearningContext,
  referenceConsensus,
} from '../src/services/reference-retrieval.js';
import type { RetrievedReference, VisualLearningContext } from '../src/services/reference-retrieval.js';
import { applyLearningConstraints } from '../src/services/creative-director.js';
import { validateEdl } from '../src/services/edl.js';
import {
  createDownloadingReference, createReference, deleteReference, finalizeDownloadedReference, getReference,
  referenceDir, referenceView, listReferences, updateReference,
} from '../src/services/reference-library.js';
import type { ReferenceRow } from '../src/services/reference-library.js';
import { parseEbur128 } from '../src/services/reference-analysis.js';
import path from 'node:path';
import fs from 'node:fs';

initDb();

function measurements(over: Partial<ReferenceMeasurements> = {}): ReferenceMeasurements {
  return { ...EMPTY_MEASUREMENTS, duration: 60, width: 1920, height: 1080, fps: 30, cutCount: 30, cutCpm: 30, ...over };
}

function profileFrom(over: Partial<ReferenceMeasurements> = {}, ai: Record<string, unknown> | null = null) {
  const m = measurements(over);
  return buildStyleProfile({
    ai: ai as never,
    measurements: m,
    meta: { name: 'test ref', duration: m.duration, width: m.width, height: m.height, fps: m.fps },
    model: ai ? 'test-model' : null,
  });
}

function ref(id: string, ai: Record<string, unknown>): RetrievedReference {
  return {
    id, name: id, category: null, score: 1,
    parts: { content: 0, style: 0, preference: 0, visual: 0, history: 0 },
    profile: profileFrom({}, ai),
    features: [], usage: { uses: 0, good: 0, bad: 0 },
  } as RetrievedReference;
}

function syntheticRef(over: Partial<ReferenceRow> = {}): ReferenceRow {
  return {
    id: 'ref_test_1',
    name: 'Fast gaming montage',
    description: 'fast cuts and zooms',
    category: 'gaming',
    tags: JSON.stringify(['fast', 'zoom']),
    source_path: 'C:/nonexistent.mp4',
    thumbnail_path: null,
    mime: 'video/mp4',
    duration: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    size_bytes: 1000,
    status: 'analyzed',
    analysis_version: 1,
    error: null,
    enabled: 1,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...over,
  };
}

/* ---------------- style profile ---------------- */

test('style profile: builds valid, versioned profile from measurements', () => {
  const p = profileFrom();
  const parsed = STYLE_PROFILE_SCHEMA.safeParse(p);
  assert(parsed.success, `profile must satisfy schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2))}`);
  assertEquals(p.profileVersion, 1);
  assertEquals(p.pacing.cutCpm.value, 30);
  assertEquals(p.pacing.cutCpm.confidence > 0.5, true, 'local measurement is high confidence');
  assertEquals(p.visualStyle.colorGrade.value, 'unknown', 'no AI => qualitative unknown');
  assert(overallConfidence(p) > 0, 'overall confidence positive');
});

test('style profile: pathological measurements clamp to schema range instead of failing', () => {
  const p = profileFrom({ averageShotDuration: 0.05, cutCpm: 900, loudnessRange: 90, integratedLoudness: 5 });
  const parsed = STYLE_PROFILE_SCHEMA.safeParse(p);
  assert(parsed.success, `clamped profile must satisfy schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  assertEquals(p.pacing.averageShotDuration.value, 0.2, 'shot duration clamped to schema floor');
  assertEquals(p.pacing.cutCpm.value, 240, 'cut rate clamped to schema ceiling');
  assertEquals(p.audio.loudnessRange.value, 40, 'loudness range clamped to schema ceiling');
  assertEquals(p.audio.integratedLoudness.value, 0, 'integrated loudness clamped to schema ceiling');
});

test('style profile: AI observations are sanitized, numbers stay local', () => {
  const p = profileFrom({ cutCpm: 8 }, {
    visual: { colorGrade: 'warm', motionGraphics: 'nonsense_tier' },
    camera: { zoomFrequency: 'high' },
    subtitles: { style: 'karaoke' },
    confidence: 0.9,
  });
  assertEquals(p.visualStyle.colorGrade.value, 'warm');
  assertEquals(p.visualStyle.motionGraphics.value, 'unknown', 'invalid tier degrades to unknown');
  assertEquals(p.camera.zoomFrequency.value, 'high');
  assertEquals(p.subtitles.style.value, 'karaoke');
  assertEquals(p.pacing.cutCpm.value, 8, 'cut rate is local, never from the model');
});

test('tiers map monotonically and round-trip through rank', () => {
  assertEquals(tierFromCutCpm(0.5), 'very_low');
  assertEquals(tierFromCutCpm(4), 'medium');
  assertEquals(tierFromCutCpm(90), 'very_high');
  assertEquals(tierFromLoudnessRange(1), 'very_low');
  assertEquals(tierFromLoudnessRange(12), 'high');
  for (const t of ['very_low', 'low', 'medium', 'medium_high', 'high', 'very_high'] as const) {
    assertEquals(rankToTier(tierRank(t)!), t, `${t} round-trips through rank`);
  }
  assert(tierRank('low')! < tierRank('medium')! && tierRank('medium')! < tierRank('high')!, 'rank is monotonic');
  assertEquals(tierRank('unknown'), null);
});

/* ---------------- learning events + aggregation ---------------- */

test('parseEbur128 reads the trailing summary, not the per-second status', () => {
  const stderr = [
    '[Parsed_ebur128_0 @ 0x1] t: 1.0 M: -20.1 S: -120.7 I: -20.1 LUFS LRA: 0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] Summary:',
    '    I:         -20.0 LUFS',
    '    LRA:         0.4 LU',
    '    Peak:       -18.5 dBFS',
  ].join('\n');
  const l = parseEbur128(stderr)!;
  assertEquals(l.integrated, -20.0);
  assertEquals(l.lra, 0.4);
  assertEquals(l.truePeak, -18.5);
  assertEquals(parseEbur128('nothing here'), null);
});

test('learning events: dedupe keys are idempotent', () => {
  const first = recordLearningEvent({
    eventType: 'feature_change', feature: 'zoom_intensity', source: 'explicit',
    newValue: 0.4, dedupeKey: 'unit-dedupe-1',
  });
  const second = recordLearningEvent({
    eventType: 'feature_change', feature: 'zoom_intensity', source: 'explicit',
    newValue: 0.4, dedupeKey: 'unit-dedupe-1',
  });
  assertEquals(first.inserted, true);
  assertEquals(second.inserted, false, 'same dedupe key coalesces');
  assertEquals(first.id, second.id);
});

test('learning events: invalid values fall back to overall instead of being lost', () => {
  const ev = recordLearningEvent({
    eventType: 'feature_change', feature: 'pacing', source: 'implicit',
    newValue: 'warp-speed', dedupeKey: 'unit-invalid-1',
  });
  const row = q.get<LearningEventRow>('SELECT * FROM learning_events WHERE id = ?', ev.id)!;
  assertEquals(row.feature, 'overall');
});

test('aggregation: deterministic weighted mean with consistency', () => {
  const rows: LearningEventRow[] = [0.2, 0.3, 0.25].map((v, i) => ({
    id: `e${i}`, event_type: 'feature_change', source: 'explicit', feature: 'zoom_intensity',
    prev_value: null, new_value: JSON.stringify(v), value_kind: 'numeric', clip_id: null, project_id: null,
    job_id: null, context: null, weight: 2, status: 'processed', dedupe_key: `k${i}`,
    created_at: '2026-01-01 00:00:00', processed_at: null,
  }));
  const agg = aggregateGroup('zoom_intensity', '', rows)!;
  assertEquals(agg.value.value, 0.25, 'weighted mean of 0.2/0.3/0.25');
  assertEquals(agg.explicitObservations, 3);
  assert(agg.confidence > 0.5, 'tight clustering yields decent confidence');
  assert(agg.confidence <= 1, 'confidence bounded');
});

test('aggregation: categorical majority wins with vote share confidence', () => {
  const mk = (v: string, i: number): LearningEventRow => ({
    id: `c${i}`, event_type: 'feature_change', source: 'explicit', feature: 'pacing',
    prev_value: null, new_value: JSON.stringify(v), value_kind: 'categorical', clip_id: null, project_id: null,
    job_id: null, context: null, weight: 2, status: 'processed', dedupe_key: `ck${i}`,
    created_at: '2026-01-01 00:00:00', processed_at: null,
  });
  const agg = aggregateGroup('pacing', '', [mk('fast', 0), mk('fast', 1), mk('slow', 2)])!;
  assertEquals(agg.value.value, 'fast');
  assert(agg.confidence > 0 && agg.confidence < 1, 'vote share confidence');
});

test('normalizeFeatureValue clamps numerics and rejects unknown categories', () => {
  assertEquals(normalizeFeatureValue('zoom_intensity', 1.7)!.value, 1);
  assertEquals(normalizeFeatureValue('zoom_intensity', -3)!.value, 0);
  assertEquals(normalizeFeatureValue('pacing', 'fast')!.value, 'fast');
  assertEquals(normalizeFeatureValue('pacing', 'ludicrous'), null);
  assertEquals(normalizeFeatureValue('color_grade', 'WARM')!.value, 'warm', 'case-insensitive');
  assert(normalizeFeatureValue('broll_density', 'low') !== null, 'tier densities accepted');
});

test('detectContextKey: deterministic category detection', () => {
  assertEquals(detectContextKey({ title: 'CS2 ranked highlights' }), 'gaming');
  assertEquals(detectContextKey({ title: 'interview with the CEO' }), 'interview');
  assertEquals(detectContextKey({ title: 'how to bake bread', transcriptText: 'tutorial step 1' }), 'tutorial');
  assertEquals(detectContextKey({ title: 'random vlog day' }), 'vlog');
  assertEquals(detectContextKey({ title: 'zzz' }), '');
});

/* ---------------- preferences: engine + manual precedence ---------------- */

test('learning run: recomputes preferences from events, manual values win', () => {
  const feature: PreferenceFeature = 'music_intensity';
  setManualPreference(feature, '', 'none');
  const before = listPreferences({ feature })[0];
  assertEquals(before.source, 'manual');

  for (let i = 0; i < 4; i++) {
    recordLearningEvent({
      eventType: 'feature_change', feature, source: 'explicit', newValue: 'high',
      dedupeKey: `unit-run-${i}`,
    });
  }
  runLearningUpdate('rebuild');
  const after = resolvePreferences('').get(feature)!;
  assertEquals(after.source, 'manual', 'learned aggregation must not overwrite a manual preference');
  assertEquals(after.value.value, 'none');

  deletePreference(listPreferences({ feature })[0].id);
  runLearningUpdate('rebuild');
  const learned = resolvePreferences('').get(feature)!;
  assertEquals(learned.source, 'learned');
  assertEquals(learned.value.value, 'high');
});

test('resolvePreferences: context-specific overrides global; suppression hides', () => {
  setManualPreference('pacing', '', 'medium');
  setManualPreference('pacing', 'gaming', 'fast');
  const global = resolvePreferences('').get('pacing')!;
  const gaming = resolvePreferences('gaming').get('pacing')!;
  assertEquals(global.value.value, 'medium');
  assertEquals(gaming.value.value, 'fast', 'context value wins over global');

  const row = listPreferences({ feature: 'pacing', contextKey: 'gaming' })[0];
  updatePreference(row.id, { status: 'suppressed' });
  const afterSuppress = resolvePreferences('gaming').get('pacing')!;
  assertEquals(afterSuppress.value.value, 'medium', 'suppressed context preference falls back to global');
});

test('snapshots: every manual mutation is recoverable', async () => {
  const before = resolvePreferences('').get('pacing')!;
  createPreferenceSnapshot('unit test snapshot');
  setManualPreference('pacing', '', 'fast');
  assertEquals(resolvePreferences('').get('pacing')!.value.value, 'fast');
  const snaps = q.all<{ id: string; reason: string }>("SELECT id, reason FROM preference_snapshots WHERE reason LIKE 'unit%' ORDER BY created_at DESC LIMIT 1");
  assert(snaps.length === 1, 'snapshot row exists');
  restoreSnapshot(snaps[0].id);
  assertEquals(resolvePreferences('').get('pacing')!.value.value, before.value.value, 'restore brings the old value back');
});

test('resetPreferences: learned-only by default, manual protected; fingerprint changes', () => {
  setManualPreference('sfx_density', '', 'low');
  recordLearningEvent({ eventType: 'feature_change', feature: 'sfx_density', source: 'implicit', newValue: 'high', dedupeKey: 'unit-reset-1' });
  runLearningUpdate('rebuild');
  assertEquals(resolvePreferences('').get('sfx_density')!.value.value, 'low', 'manual still wins before reset');

  const fpBefore = learningFingerprint();
  resetPreferences({ includeManual: false });
  assertEquals(resolvePreferences('').get('sfx_density')!.value.value, 'low', 'manual survived learned reset');

  setManualPreference('sfx_density', '', 'high');
  assert(learningFingerprint() !== fpBefore, 'fingerprint changes when effective preference changes');
});

/* ---------------- retrieval ---------------- */

test('tokenize + overlap: stopwords removed, case normalised', () => {
  const t = tokenize('The BEST gaming MOMENTS of 2026 and more');
  assert(t.includes('gaming') && t.includes('moments'), `has keywords: ${t.join(',')}`);
  assert(!t.includes('the') && !t.includes('and'), 'stopwords removed');
});

test('sceneTierTarget: cut rate maps to pacing tiers', () => {
  assertEquals(sceneTierTarget(null).cut, 'unknown');
  assertEquals(sceneTierTarget({ cuts: [], duration: 60 } as never).cut, 'very_low');
  assertEquals(sceneTierTarget({ cuts: new Array(20).fill(0), duration: 60 } as never).cut, 'very_high');
});

test('scoreReference: content overlap and usage history move the score', () => {
  const profile = profileFrom({ cutCpm: 40 });
  const input = {
    title: 'Fast gaming montage highlights',
    transcriptText: 'gaming gaming frag',
    scene: null, duration: 60, hasSpeech: true, hasAudio: true, graphicsEnabled: true,
  };
  const hit = scoreReference(syntheticRef(), profile, input, resolvePreferences(''));
  const miss = scoreReference(syntheticRef({ name: 'Calm cooking documentary', description: 'slow', tags: null, category: 'food' }), profile, input, resolvePreferences(''));
  assert(hit.parts.content > miss.parts.content, `content term: ${hit.parts.content} > ${miss.parts.content}`);
  assert(hit.score >= 0 && hit.score <= 1, 'score bounded');
});

test('selectRelevantFeatures: speech/graphics gate the groups', () => {
  const profile = profileFrom({ cutCpm: 12 }, {
    visual: { colorGrade: 'warm' },
    camera: { zoomFrequency: 'high', zoomIntensity: 0.0 },
    subtitles: { style: 'karaoke', maxWordsPerGroup: 3 },
    audio: { musicEnergy: 'high', sfxDensity: 'low' },
  });
  const withSpeech = selectRelevantFeatures(profile, { title: null, transcriptText: null, scene: null, duration: 60, hasSpeech: true, hasAudio: true, graphicsEnabled: true });
  const noSpeech = selectRelevantFeatures(profile, { title: null, transcriptText: null, scene: null, duration: 60, hasSpeech: false, hasAudio: false, graphicsEnabled: false });
  const names = (f: { feature: string }[]) => f.map((x) => x.feature);
  assert(names(withSpeech).includes('subtitleStyle'), 'subtitle features included when speech');
  assert(!names(noSpeech).includes('subtitleStyle'), 'subtitle features excluded without speech');
  assert(names(noSpeech).includes('zoomFrequency'), 'camera always relevant');
  assert(withSpeech.length <= 12, 'feature list capped');
});

test('buildConstraints: learned preferences become bounded, deterministic caps', () => {
  for (const [feature, value] of [
    ['zoom_frequency', 'low'], ['zoom_intensity', null], ['broll_density', 'none'], ['sfx_density', 'high'],
    ['motion_graphics', 'low'], ['subtitle_density', 'very_low'], ['color_grade', 'warm'], ['pacing', 'fast'],
  ] as const) {
    if (value !== null) setManualPreference(feature, '', value);
  }
  const constraints = buildConstraints(resolvePreferences(''));
  assert(constraints.maxFramings !== null && constraints.maxFramings >= 1, 'framing cap set');
  assertEquals(constraints.shotCeiling, 'wide', 'low zoom frequency keeps shots wide');
  assertEquals(constraints.maxBroll, 0, 'broll none => 0');
  assertEquals(constraints.maxSfx, 6, 'sfx high => 6');
  assertEquals(constraints.maxEmphasis, 8, 'low subtitle density => 8 emphasis words');
  assertEquals(constraints.preferredGrade, 'warm');
  assertEquals(constraints.pacingHint, 'fast');
});

test('referenceConsensus: strict majority across selected references only', () => {
  const studio: Record<string, unknown> = {
    visual: { colorGrade: 'desaturated', motionGraphics: 'low' },
    camera: { zoomFrequency: 'high' },
    audio: { musicEnergy: 'high' },
    confidence: 0.9,
  };
  const different: Record<string, unknown> = {
    visual: { colorGrade: 'warm', motionGraphics: 'high' },
    camera: { zoomFrequency: 'low' },
    audio: { musicEnergy: 'low' },
    confidence: 0.9,
  };
  const consensus = referenceConsensus([ref('a', studio), ref('b', studio), ref('c', different)]);
  assertEquals(consensus.zoom_frequency, 'high', '2 of 3 zoom votes win');
  assertEquals(consensus.motion_graphics, 'low');
  assertEquals(consensus.color_grade, 'cinematic', 'desaturated maps to cinematic');
  assertEquals(consensus.music_intensity, 'high');

  const split = referenceConsensus([
    ref('a', studio), ref('b', different),
    ref('c', { camera: { zoomFrequency: 'medium' }, confidence: 0.9 }),
  ]);
  assertEquals(split.zoom_frequency, undefined, 'no majority => no consensus feature');
});

test('buildConstraints: reference consensus is a soft default; learned/manual wins', () => {
  const consensus = { zoom_frequency: 'high', color_grade: 'cinematic' };
  const fromConsensus = buildConstraints(new Map(), consensus);
  assertEquals(fromConsensus.shotCeiling, 'close', 'high zoom consensus forces close shots');
  assertEquals(fromConsensus.preferredGrade, 'cinematic');

  setManualPreference('zoom_frequency', '', 'low');
  for (const p of listPreferences({ feature: 'color_grade' })) deletePreference(p.id);
  const withManual = buildConstraints(resolvePreferences(''), consensus);
  assertEquals(withManual.shotCeiling, 'wide', 'manual preference overrides reference consensus');
  assertEquals(withManual.preferredGrade, 'cinematic', 'consensus still fills the unset feature');
  assertEquals(withManual.minFramings, null, 'manual low zoom clears the consensus framing floor');
});

test('referenceConsensus: extended targets (sfx, transitions, subtitles, text placement)', () => {
  const punchy: Record<string, unknown> = {
    visual: { overlayPosition: 'top' },
    camera: { zoomFrequency: 'high' },
    audio: { musicEnergy: 'low', sfxDensity: 'high' },
    transitions: { preferred: ['whip', 'fade'] },
    subtitles: { style: 'word_by_word' },
    confidence: 0.9,
  };
  const mild: Record<string, unknown> = {
    visual: { overlayPosition: 'mixed' },
    camera: { zoomFrequency: 'high' },
    audio: { musicEnergy: 'low', sfxDensity: 'low' },
    transitions: { preferred: ['cut'] },
    subtitles: { style: 'bold_uppercase' },
    confidence: 0.9,
  };
  const consensus = referenceConsensus([ref('a', punchy), ref('b', punchy), ref('c', mild)]);
  assertEquals(consensus.sfx_density, 'high', '2 of 3 sfx votes win');
  assertEquals(consensus.transition_preference, 'slide', 'whip maps to the closest EDL transition (slide)');
  assertEquals(consensus.subtitle_style, 'karaoke', 'word_by_word maps to karaoke');
  assertEquals(consensus.overlay_position, 'top', 'mixed placements never form a consensus');

  const constraints = buildConstraints(new Map(), consensus);
  assert(constraints.minFramings !== null && constraints.minFramings >= 4, 'punchy references raise a framing floor');
  assertEquals(constraints.sfxBaseline, 2, 'high sfx density sets a baseline at cuts');
  assertEquals(constraints.titlePosition, 'top', 'overlay position becomes the text placement target');
});

test('applyLearningConstraints: framing floor, sfx baseline at cuts, text placement', () => {
  const raw = {
    version: 1, aspectRatio: '16:9', style: {},
    framings: [{ start: 0, end: 12, shot: 'medium' }],
    titles: [{ text: 'Judul', start: 0.5, end: 4, position: 'center' }],
  };
  const v = validateEdl(raw, { duration: 12, aspectRatio: '9:16', clipStart: 0, clipEnd: 12, words: [] });
  assert(v.ok && v.edl, `expected valid EDL: ${v.errors.join(', ')}`);
  const consensus = { zoom_frequency: 'high', sfx_density: 'high', overlay_position: 'top' };
  const learning = {
    contextKey: '', references: [], preferences: [], insights: [], notes: [],
    consensus, constraints: buildConstraints(new Map(), consensus),
  } as VisualLearningContext;

  const { edl, provenance } = applyLearningConstraints(v.edl!, learning, null, { sfxIds: ['whoosh'] });
  assert(edl.framings.length >= 5, 'framing floor padded the timeline');
  assert(edl.framings.every((f) => f.end - f.start >= 1.4), 'padding never creates micro shots');
  for (let i = 1; i < edl.framings.length; i++) {
    assertEquals(edl.framings[i].start, edl.framings[i - 1].end, 'padding keeps framings contiguous');
  }
  assertEquals(edl.sfx.length, 2, 'sfx baseline inserted');
  assert(edl.sfx.every((s) => s.libraryId === 'whoosh' && s.volumeDb === -6 && s.at > 0 && s.at < 12), 'sfx valid and inside the timeline');
  assert(edl.titles.every((t) => t.position === 'top'), 'titles moved to the reference placement');
  assert(provenance?.constraintApplications.some((a) => a.includes('framings 1 ->')), 'padding recorded in provenance');
  assert(provenance?.constraintApplications.some((a) => a.includes('sfx +2')), 'sfx baseline recorded in provenance');
  assert(provenance?.preferenceApplications.some((a) => a.includes('text placement')), 'title move recorded in provenance');
});

test('buildVisualLearningContext: null when learning is off or empty', () => {
  const input = { title: null, transcriptText: null, scene: null, duration: 30, hasSpeech: false, hasAudio: false, graphicsEnabled: false };
  setSettings('learning', { enabled: false });
  assertEquals(buildVisualLearningContext(input), null);
  setSettings('learning', { enabled: true });
  resetPreferences({ includeManual: true });
  assertEquals(buildVisualLearningContext(input), null, 'enabled but nothing learned and no references => null');
  setManualPreference('pacing', '', 'fast');
  const ctx = buildVisualLearningContext(input);
  assert(ctx !== null && ctx.preferences.length === 1, 'context appears once something is known');
});

/* ---------------- reference library CRUD (no ffmpeg) ---------------- */

test('reference library: update/disable/delete lifecycle without a file', () => {
  q.run(
    `INSERT INTO reference_library (id, name, source_path, mime, duration, status, enabled)
     VALUES ('unitref1', 'Unit Ref', 'C:/none.mp4', 'video/mp4', 12, 'analyzed', 1)`
  );
  const updated = updateReference('unitref1', { category: 'podcast', tags: ['talking'], enabled: false })!;
  assertEquals(updated.category, 'podcast');
  assertEquals(JSON.parse(updated.tags!), ['talking']);
  assertEquals(updated.enabled, 0);
  const view = referenceView(updated);
  assertEquals(view.enabled, false);
  assertEquals(view.sourceUrl, '/api/references/unitref1/source');
  assert(!('source_path' in view), 'views never leak filesystem paths');
  const enabledOnly = listReferences({ enabledOnly: true });
  assert(!enabledOnly.references.some((r) => r.id === 'unitref1'), 'disabled references excluded when enabledOnly');
  q.run("DELETE FROM reference_library WHERE id = 'unitref1'");
  assertEquals(getReference('unitref1'), undefined);
});

test('reference from link: placeholder row; failed finalize marks failed and cleans the file', async () => {
  const ref = createDownloadingReference({ url: 'https://www.tiktok.com/@user/video/123', name: 'Link Ref' });
  assertEquals(ref.status, 'downloading');
  assertEquals(ref.name, 'Link Ref');
  const bare = createDownloadingReference({ url: 'https://youtu.be/dQw4w9WgXcQ' });
  assertEquals(bare.status, 'downloading');
  assert(bare.name.length > 0, 'fallback name derived from the URL');
  const phantom = path.join(referenceDir(ref.id), 'missing.mp4');
  let threw = '';
  try { await finalizeDownloadedReference(ref.id, phantom); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes('missing'), 'finalize throws a clear error on a missing file');
  assertEquals(getReference(ref.id)!.status, 'failed');
  assert(!fs.existsSync(phantom), 'no phantom file created');
  deleteReference(ref.id);
  deleteReference(bare.id);
});

/* ---------------- job plumbing ---------------- */

test('learning events enqueue a debounced learning_update job', () => {
  maybeEnqueueLearningUpdate();
  const jobs = q.all<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'learning_update'");
  assert((jobs[0]?.n ?? 0) >= 1, 'learning_update job enqueued');
  // second call must not enqueue a duplicate (debounce window)
  const before = jobs[0].n;
  maybeEnqueueLearningUpdate();
  const after = q.all<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'learning_update'")[0].n;
  assertEquals(after, before, 'debounced');
});

test('cleanup: wipe preferences/events so downstream integration tests start neutral', () => {
  q.run('DELETE FROM learning_events');
  q.run('DELETE FROM learning_preferences');
  q.run('DELETE FROM learning_experience');
  q.run("DELETE FROM jobs WHERE type = 'learning_update' AND status = 'queued'");
  assertEquals(listPreferences({}).length, 0, 'preferences wiped');
});
