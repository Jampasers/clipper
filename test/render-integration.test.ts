/* Real-FFmpeg integration test for the composed render: hook teaser copy + watermark
 * overlay + BGM with speech ducking + loudnorm/limiter QA. No AI, no Chrome:
 * fixtures are generated with lavfi and the editing plan is supplied directly. */
import { test, assert, assertEquals } from './runner.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export async function registerRenderIntegration(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-render-'));
  const ff = (args: string[]) => spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  const probeBin = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  if (probeBin.status !== 0) {
    console.log('\n  (skipping composed-render integration: ffmpeg/ffprobe unavailable)');
    return;
  }

  const src = path.join(base, 'src.mp4');
  const wmPng = path.join(base, 'wm.png');
  const bgm = path.join(base, 'bgm.wav');
  const longBgm = path.join(base, 'bgm_long.wav');

  const r1 = ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
    '-ac', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', src]);
  assert(r1.status === 0, `fixture source failed: ${(r1.stderr || '').slice(0, 300)}`);
  const r2 = ff(['-f', 'lavfi', '-i', 'color=c=red@0.9:s=120x40', '-frames:v', '1', wmPng]);
  assert(r2.status === 0, 'fixture watermark png failed');
  const r3 = ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', '-ar', '48000', bgm]);
  assert(r3.status === 0, 'fixture music failed');
  // longer than the clip: the render must loop/trim it, not fail
  const r4 = ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-ac', '1', '-ar', '48000', longBgm]);
  assert(r4.status === 0, 'fixture long music failed');

  const { initDb, q } = await import('../src/lib/sqlite.js');
  const { probeVideo } = await import('../src/lib/ffmpeg.js');
  const { renderClip } = await import('../src/services/render.js');
  const { buildTimeline } = await import('../src/services/timeline.js');
  const { defaultRenderOptions } = await import('../src/services/render-options.js');
  initDb();

  const probe = await probeVideo(src);
  assert(probe.duration > 10 && probe.hasAudio, 'fixture probe sane');

  // watermark + music rows (files generated above)
  q.run(
    `INSERT INTO watermarks (id, name, file_path, source_path, mime, width, height, enabled, default_position, width_percent, opacity, margin, x, y)
     VALUES ('wint','IntTest',?,NULL,'image/png',120,40,1,'top-left',20,1,10,NULL,NULL)`,
    wmPng.replace(/\\/g, '/')
  );
  q.run(
    `INSERT INTO music_assets (id, name, file_path, mime, mood, genre, energy, bpm, duration, license, attribution, enabled)
     VALUES ('mint','IntTest',?,'audio/wav','cinematic','test',3,90,2,NULL,NULL,1)`,
    longBgm.replace(/\\/g, '/')
  );

  // b-roll + sfx fixtures for the adaptive creative render
  const brollMp4 = path.join(base, 'broll.mp4');
  const sfxWav = path.join(base, 'sfx.wav');
  const r5 = ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', brollMp4]);
  assert(r5.status === 0, 'fixture b-roll video failed');
  const r6 = ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-ac', '1', '-ar', '48000', sfxWav]);
  assert(r6.status === 0, 'fixture sfx failed');
  q.run(
    `INSERT INTO broll_assets (id, name, file_path, mime, kind, width, height, duration, tags, source, license, attribution, enabled)
     VALUES ('bint','IntBroll',?,'video/mp4','video',640,360,8,'desk,laptop,office','upload',NULL,NULL,1)`,
    brollMp4.replace(/\\/g, '/')
  );
  q.run(
    `INSERT INTO sound_effects (id, name, file_path, mime, duration, tags, source, license, attribution, enabled)
     VALUES ('sint','IntSfx',?,'audio/wav',2,'whoosh,transition','upload',NULL,NULL,1)`,
    sfxWav.replace(/\\/g, '/')
  );

  const options = defaultRenderOptions();
  options.aspect = '9:16';
  options.watermark = { enabled: true, ids: ['wint'] };
  options.hook = { enabled: false, duration: 7, allowFallback: false };
  options.backgroundMusic = { enabled: true, selection: 'mint', voiceDucking: true, volumeDb: 0, duckDb: 8, fadeIn: 0.5, fadeOut: 0.5 };
  options.subtitles = { enabled: false, style: 'ai', aiHighlight: false, animations: false };

  // hook span inside the clip: 4..7s, exactly the composed timeline case
  const timeline = buildTimeline(2, 10, { start: 4, end: 7 });
  const plan = {
    version: 4 as const,
    clipId: 'inttest',
    clipStart: 2,
    clipEnd: 10,
    optionsHash: 'test',
    timeline,
    hook: { start: 4, end: 7, text: 'hook', reason: 'test', score: 1, source: 'fallback' as const, candidates: [] },
    subtitle: null,
    music: { assetId: 'mint', name: 'IntTest', mood: 'cinematic', reason: 'test', source: 'manual' as const },
    creative: null,
    creativeSource: null,
    creativeModel: null,
    model: '',
    createdAt: new Date().toISOString(),
  };

  test('composed render: hook teaser copy + watermark + ducked BGM passes QA', async () => {
    const r = await renderClip({
      clip: { id: 'inttest', start: 2, end: 10, aspect: '9:16' },
      sourcePath: src,
      probe,
      kind: 'preview',
      transcript: null,
      options,
      plan,
    });
    assert(fs.existsSync(r.output), 'output exists');
    assertEquals(r.summary.hook, true);
    assertEquals(r.summary.music, 'IntTest');
    assertEquals(r.summary.watermarkCount, 1);
assertEquals(round1(r.duration), 10.5);
    const outProbe = await probeVideo(r.output);
    assert(outProbe.hasAudio, 'audio track present');
    assertEquals(outProbe.width, 540, 'preview width');
    assertEquals(outProbe.height, 960, 'preview height');
    assert(r.size > 50000, 'encode has real content');
  });

  test('music-only render works when the source has no audio', async () => {
    const mute = path.join(base, 'mute.mp4');
    const r0 = ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mute]);
    assert(r0.status === 0, 'mute fixture failed');
    const muteProbe = await probeVideo(mute);
    const muteOpts = { ...options, aspect: '16:9' as const };
    const res = await renderClip({
      clip: { id: 'intmute', start: 1, end: 6, aspect: '16:9' },
      sourcePath: mute,
      probe: muteProbe,
      kind: 'preview',
      transcript: null,
      options: muteOpts,
      plan: { ...plan, clipId: 'intmute', clipStart: 1, clipEnd: 6, timeline: buildTimeline(1, 6, null), hook: null },
    });
    assert(fs.existsSync(res.output), 'output exists');
    const p = await probeVideo(res.output);
    assert(p.hasAudio, 'BGM alone provides the audio track');
    assertEquals(round1(res.duration), 5);
  });

  test('adaptive render: creative EDL drives punch-in, grade and the graphics overlay', async () => {
    const { validateEdl } = await import('../src/services/edl.js');
    const v = validateEdl(
      {
        version: 1,
        aspectRatio: '9:16',
        style: {
          grade: 'warm', backgroundFill: 'crop', punchIn: true,
          transition: { type: 'fade', duration: 0.4 }, edgeFade: true, progressBar: false, accentColor: '#FFD400',
        },
        framings: [{ start: 0, end: 4, shot: 'close', focus: 'speaker', ease: 0.6 }],
        titles: [{ text: 'Adaptive Test', start: 0.5, end: 3.5, position: 'center' }],
        lowerThirds: [], statCards: [], callouts: [], broll: [], sfx: [], emphasis: [], music: null,
        audio: { cleanup: true, ducking: true },
      },
      { duration: 8, aspectRatio: '9:16', clipStart: 2, clipEnd: 10 }
    );
    assert(v.ok && v.edl, 'creative EDL is valid');
    const adaptOpts = { ...options, creative: { mode: 'adaptive' as const, qualityReview: false } };
    const r = await renderClip({
      clip: { id: 'intadapt', start: 2, end: 10, aspect: '9:16' },
      sourcePath: src,
      probe,
      kind: 'preview',
      transcript: null,
      options: adaptOpts,
      plan: { ...plan, clipId: 'intadapt', creative: v.edl, creativeSource: 'fallback' as const },
    });
    assert(fs.existsSync(r.output), 'adaptive output exists');
    assertEquals(r.summary.creativeMode, 'adaptive');
    assertEquals(r.summary.creativeSource, 'fallback');
    const p = await probeVideo(r.output);
    assertEquals(p.width, 540, 'preview width preserved');
    assertEquals(p.height, 960, 'preview height preserved');
    assert(p.hasAudio, 'audio still present');
  });

  test('adaptive render applies a b-roll overlay and an sfx placement', async () => {
    const { validateEdl } = await import('../src/services/edl.js');
    const v = validateEdl(
      {
        version: 1,
        aspectRatio: '9:16',
        style: {
          grade: 'none', backgroundFill: 'crop', punchIn: false,
          transition: { type: 'fade', duration: 0.4 }, edgeFade: false, progressBar: false, accentColor: '#FFD400',
        },
        framings: [], titles: [], lowerThirds: [], statCards: [], callouts: [], emphasis: [], music: null,
        broll: [{ assetId: 'bint', query: null, start: 1, end: 3, mode: 'cover', position: 'bottom-right', sizePercent: 34 }],
        sfx: [{ libraryId: 'sint', at: 0.5, volumeDb: -6 }],
        audio: { cleanup: true, ducking: true },
      },
      { duration: 8, aspectRatio: '9:16', clipStart: 2, clipEnd: 10, brollIds: ['bint'], sfxIds: ['sint'] }
    );
    assert(v.ok && v.edl, 'b-roll EDL is valid');
    const adaptOpts = { ...options, creative: { mode: 'adaptive' as const, qualityReview: false } };
    const r = await renderClip({
      clip: { id: 'intbroll', start: 2, end: 10, aspect: '9:16' },
      sourcePath: src,
      probe,
      kind: 'preview',
      transcript: null,
      options: adaptOpts,
      plan: { ...plan, clipId: 'intbroll', creative: v.edl, creativeSource: 'fallback' as const },
    });
    assert(fs.existsSync(r.output), 'b-roll output exists');
    const p = await probeVideo(r.output);
    assertEquals(p.width, 540, 'preview width preserved');
    assert(p.hasAudio, 'voice + sfx mix present');
    // the blue cover b-roll must visibly replace the frame inside its window:
    // compare average luma inside (t=2) vs outside (t=0.5) the window
    const yavg = (t: number) => {
      const res = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-nostdin', '-v', 'info', '-ss', String(t), '-i', r.output, '-frames:v', '1', '-vf', 'signalstats,metadata=print', '-f', 'null', '-'],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(res.stderr + res.stdout);
      assert(m, `signalstats frame at ${t}s`);
      return parseFloat(m[1]);
    };
    const inside = yavg(2);
    const outside = yavg(0.5);
    assert(Math.abs(inside - outside) > 12, `b-roll changes pixels inside its window (inside=${inside}, outside=${outside})`);
  });
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
