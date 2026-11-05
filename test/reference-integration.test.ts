/* Reference library + analysis integration (real FFmpeg, AI pointed at a dead
 * local port). The deterministic measurement path must still produce a usable,
 * schema-valid profile when vision is unavailable (status: partial). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, assert, assertEquals } from './runner.js';
import { initDb } from '../src/lib/sqlite.js';
import { setSettings } from '../src/lib/settings.js';
import { config } from '../src/config.js';
import {
  createReference, getLatestAnalysis, getReference, deleteReference,
  listCategories, referenceDir, listReferences,
} from '../src/services/reference-library.js';
import { analyzeReference } from '../src/services/reference-analysis.js';
import { retrieveReferences, buildVisualLearningContext, compactLearningContext } from '../src/services/reference-retrieval.js';
import { STYLE_PROFILE_SCHEMA, type StyleProfile } from '../src/services/style-profile.js';

initDb();
setSettings('ai', { base_url: 'http://127.0.0.1:9', api_key: 'test-key', default_model: 'x', fallback_model: '', vision_model: '', request_retries: 0 });
setSettings('learning', { enabled: true, auto_analyze: true, use_references: true, max_references: 3, min_reference_score: 0.1 });

const fixtureDir = path.join(config.dirs.references, '_test_fixtures');
fs.mkdirSync(fixtureDir, { recursive: true });

function makeVideo(name: string, dur: number): string {
  const file = path.join(fixtureDir, name);
  const r = spawnSync(
    config.ffmpeg,
    [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30:duration=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', file,
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  assert(r.status === 0, `fixture ${name} failed: ${(r.stderr || '').slice(-300)}`);
  return file;
}

export function registerReferenceIntegration(): void {
  let refId = '';

  test('reference upload: probe data is real, files land in the permanent library', async () => {
    const file = makeVideo('testref.mp4', 8);
    const ref = await createReference(file, 'testref.mp4', { name: 'Integration Ref', category: 'tests' });
    refId = ref.id;
    assert(ref.duration !== null && Math.abs(ref.duration - 8) < 1, `duration probed (${ref.duration})`);
    assertEquals(ref.width, 640);
    assertEquals(ref.height, 360);
    assertEquals(ref.mime, 'video/mp4');
    assertEquals(ref.status, 'uploaded');
    const dir = referenceDir(ref.id);
    assert(fs.existsSync(path.join(dir, 'source.mp4')), 'source copied into library dir');
    assert(!!ref.thumbnail_path && fs.existsSync(ref.thumbnail_path), 'thumbnail generated');
    assert(!fs.existsSync(file), 'temp upload removed after import');
    assert(fs.existsSync(path.join(dir, 'metadata.json')), 'metadata.json written');
  });

  test('reference analysis without vision: partial profile, schema-valid, locally measured', async () => {
    // e2e's pinAi() runs during the shared run() pass and restores real AI
    // settings, so re-pin the dead port right before this analysis.
    setSettings('ai', { base_url: 'http://127.0.0.1:9', api_key: 'test-key', default_model: 'x', fallback_model: '', vision_model: '', request_retries: 0 });
    const outcome = await analyzeReference(refId);
    assertEquals(outcome.status, 'partial', 'vision unavailable => partial, not failed');
    const row = getReference(refId)!;
    assertEquals(row.status, 'partial');
    const analysis = getLatestAnalysis(refId)!;
    assert(analysis, 'analysis row persisted');
    assertEquals(analysis.status, 'partial');
    const profile = JSON.parse(analysis.profile!) as StyleProfile;
    const parsed = STYLE_PROFILE_SCHEMA.safeParse(profile);
    assert(parsed.success, `persisted profile satisfies schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2))}`);
    const m = JSON.parse(analysis.measurements!);
    assert(m.cutCount >= 0 && m.sampledFrames > 0, `frames sampled (${m.sampledFrames})`);
    assert(m.brightness !== null && m.brightness >= 0 && m.brightness <= 1, `brightness measured (${m.brightness})`);
    assert(m.saturation !== null, 'saturation measured');
    assert(m.motionIntensity !== null && m.motionIntensity > 0, `motion measured (${m.motionIntensity})`);
    assert(m.integratedLoudness !== null && m.integratedLoudness < 0, `loudness measured (${m.integratedLoudness})`);
    assert(analysis.model === null, 'no model credited for a local-only profile');
    const framesDir = path.join(referenceDir(refId), 'frames');
    const leftovers = fs.existsSync(framesDir) ? fs.readdirSync(framesDir) : [];
    assertEquals(leftovers.length, 0, 'temporary frames cleaned up');
  });

  test('retrieval: analyzed reference is selected, features compact for the prompt', () => {
    assert(!!getReference(refId)?.enabled, 'reference enabled');
    const refs = retrieveReferences({
      title: 'integration test clip', transcriptText: 'hello world integration', scene: null,
      duration: 8, hasSpeech: true, hasAudio: true, graphicsEnabled: true,
    });
    assert(refs.length >= 1, `at least one reference retrieved (${refs.length})`);
    const hit = refs.find((r) => r.id === refId);
    assert(hit, 'our reference is among the retrieved');
    assert(hit!.score > 0 && hit!.score <= 1, `score in range (${hit!.score})`);
    assert(hit!.features.length > 0 && hit!.features.length <= 12, 'relevant features selected');
    const parts = hit!.parts;
    for (const k of ['content', 'style', 'preference', 'visual', 'history'] as const) {
      assert(parts[k] >= 0 && parts[k] <= 1, `part ${k} bounded`);
    }

    const ctx = buildVisualLearningContext({
      title: 'integration test clip', transcriptText: 'hello world integration', scene: null,
      duration: 8, hasSpeech: true, hasAudio: true, graphicsEnabled: true,
    });
    assert(ctx !== null, 'learning context built');
    assertEquals(ctx!.references.length, refs.length);
    const compact = compactLearningContext(ctx!) as { references: { name: string; style: Record<string, string> }[] };
    assert(compact.references[0].name.length > 0, 'compact context carries reference names');
    assert(Object.keys(compact.references[0].style).length > 0, 'compact context carries style features');
  });

  test('library listing counts the analyzed reference; delete removes rows and files', () => {
    const cats = listCategories();
    assert(cats.length >= 0, 'categories listed');
    const { total } = listReferences({});
    assert(total >= 1, 'reference listed');
    const dir = referenceDir(refId);
    assert(fs.existsSync(dir), 'directory exists before delete');
    assertEquals(deleteReference(refId), true);
    assertEquals(getReference(refId), undefined, 'row deleted');
    assert(!fs.existsSync(dir), 'files removed with the reference');
  });
}
