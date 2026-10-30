/* End-to-end test: real video -> probe -> whisper -> AI analysis -> clips ->
 * scoring -> dedup -> subtitle + reframe render -> QA. Builds fixtures with
 * ffmpeg lavfi + local Windows TTS; skips gracefully if TTS is unavailable. */
import { test, assert, assertEquals } from './runner.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export async function runE2E(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-e2e-'));

  const { initDb } = await import('../src/lib/sqlite.js');
  const { seedPrompts } = await import('../src/lib/prompts.js');
  const { getSettings, setSettings } = await import('../src/lib/settings.js');
  const { registerWorkers } = await import('../src/workers/worker.js');
  const { processOne } = await import('../src/lib/queue.js');
  const { createProject, getProject } = await import('../src/services/projects.js');
  const { enqueueProjectPipeline, enqueueRender } = await import('../src/services/pipeline.js');
  const { listClips, getClip, clipView } = await import('../src/services/clips.js');
  const { renderClip } = await import('../src/services/render.js');
  const { loadTranscript } = await import('../src/services/transcribe.js');
  const { probeVideo } = await import('../src/lib/ffmpeg.js');
  const { config } = await import('../src/config.js');

  initDb();
  seedPrompts();
  registerWorkers();

  // API tests run in the same `run()` pass and PUT a dummy key into the shared
  // test DB, so re-pin real AI settings right before the pipeline needs them.
  const dm = config.ai.defaultModel;
  const pinAi = () =>
    setSettings('ai', {
      ...getSettings('ai'),
      base_url: config.ai.baseUrl,
      api_key: config.ai.apiKey,
      default_model: dm,
      routing: {
        content_analysis: dm, highlight_detection: dm, clip_scoring: dm,
        clip_boundary: dm, title_generation: dm, subtitle_analysis: dm,
      },
    });
  pinAi();

  // small clip windows so a ~28s sample still yields 1+ clips
  setSettings('clipping', {
    min_clip_duration: 5, max_clip_duration: 60, target_clip_duration: 15,
    top_clips: 3, max_candidates: 6, overlap_threshold: 0.6,
  });
  // keep e2e fast + deterministic: no Chrome download in the suite
  setSettings('subtitles', { engine: 'ass' });

  const wav = path.join(base, 'speech.wav');
  const mp4 = path.join(base, 'sample.mp4');
  const script = path.join(process.cwd(), 'scripts', 'tts.ps1');
  const tts = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Text',
    'Hello and welcome. Today we are going to talk about something truly surprising. Most people believe that goldfish have a memory of only three seconds. But the truth is completely different. Scientists discovered that goldfish can remember things for months. They can even learn to press a lever for food. This proves that we greatly underestimated them. And that is the amazing fact for today.',
    '-Out', wav, '-Rate', '1'], { encoding: 'utf8' });
  if (tts.status !== 0 || !fs.existsSync(wav)) {
    console.log('\n  (skipping E2E: local TTS unavailable)');
    return;
  }
  const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=28',
    '-i', wav, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', mp4], { encoding: 'utf8' });
  assert(ff.status === 0, `ffmpeg fixture failed: ${(ff.stderr || '').slice(0, 300)}`);
  assert(fs.existsSync(mp4) && fs.statSync(mp4).size > 10000, 'fixture mp4 exists');

  let projectId = '';

  test('probe returns real media metadata', async () => {
    const probe = await probeVideo(mp4);
    assert(probe.duration > 20, `duration ${probe.duration}`);
    assertEquals(probe.width, 640);
    assert(probe.hasAudio, 'has audio stream');
    assert(probe.hasVideo, 'has video stream');
  });

  test('project pipelines to READY with a transcript', async () => {
    pinAi();
    const p = createProject('e2e sample', mp4);
    projectId = p.id;
    enqueueProjectPipeline(projectId);
    for (let i = 0; i < 60; i++) {
      const processed = await processOne();
      const st = getProject(projectId)?.status;
      if (!processed && (st === 'READY' || st === 'FAILED')) break;
      if (processed && (st === 'READY' || st === 'FAILED')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const proj = getProject(projectId)!;
    assertEquals(proj.status, 'READY', `pipeline finished (error: ${proj.error ?? 'none'})`);
    const t = loadTranscript(projectId);
    assert(t && t.segments.length >= 3, `transcript has segments (${t?.segments.length})`);
  });

  test('AI produced scored, deduplicated, in-range clips', async () => {
    const clips = listClips({ projectId }).map(clipView);
    assert(clips.length >= 1, 'at least one clip');
    const cfg = getSettings('clipping');
    for (const c of clips) {
      assert(c.duration >= cfg.min_clip_duration - 1, `duration ${c.duration} >= min`);
      assert(c.duration <= cfg.max_clip_duration + 1, `duration ${c.duration} <= max`);
      assert(c.overall != null && c.overall >= 0, 'has overall score');
      assert(Object.keys(c.scores).length >= 6, 'has score breakdown');
      assert(c.title && c.title.length > 0, 'has a title');
    }
    for (let i = 0; i < clips.length; i++)
      for (let j = i + 1; j < clips.length; j++) {
        const inter = Math.max(0, Math.min(clips[i].end, clips[j].end) - Math.max(clips[i].start, clips[j].start));
        const minLen = Math.min(clips[i].end - clips[i].start, clips[j].end - clips[j].start);
        assert(inter / minLen < cfg.overlap_threshold, 'clips are deduplicated');
      }
  });

  test('direct render produces a QA-passing vertical preview with subtitles', async () => {
    const clip = listClips({ projectId })[0];
    const proj = getProject(projectId)!;
    const meta = JSON.parse(proj.meta!);
    const trans = loadTranscript(projectId);
    const r = await renderClip({
      clip: { id: clip.id, start: clip.start, end: clip.end, aspect: '9:16', subtitle_preset: 'bold' },
      sourcePath: proj.source_path, probe: meta, kind: 'preview', transcript: trans!.segments,
  });
    assert(fs.existsSync(r.output), 'preview file exists');
    assert(r.duration > 0, 'preview has duration');
    assert(r.subtitles && fs.existsSync(r.subtitles.ass), 'ass subtitle written');
    assert(fs.readFileSync(r.subtitles!.srt, 'utf8').includes('-->'), 'srt has timing');
    assertEquals(r.width, 540);
    assertEquals(r.height, 960);
    assertEquals(r.reframe.aspect, '9:16');
  });

  test('render via background queue writes the output file', async () => {
    const clip = getClip(listClips({ projectId })[0].id)!;
    enqueueRender(clip.id, 'preview');
    for (let i = 0; i < 40; i++) {
      const processed = await processOne();
      if (!processed) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const out = path.join(process.env.PREVIEW_DIR!, `${clip.id}_preview.mp4`);
    assert(fs.existsSync(out), 'queue-rendered preview exists');
  });
}
