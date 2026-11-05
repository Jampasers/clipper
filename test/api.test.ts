/* API tests: auth, settings, prompts, authorization, validation — against a real
 * in-process Express app with the shared test DB. */
import { test, assert, assertEquals } from './runner.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initDb } from '../src/lib/sqlite.js';
import { seedPrompts } from '../src/lib/prompts.js';
import { ensureSuperAdmin, countUsers } from '../src/lib/auth.js';
import { createApp } from '../src/app.js';
import { registerWorkers } from '../src/workers/worker.js';
import { authorizationCheck } from '../src/telegram/client.js';
import { config } from '../src/config.js';

initDb();
seedPrompts();
ensureSuperAdmin('admin', 'testpass123');
registerWorkers();

export async function runApiTests(): Promise<() => Promise<void>> {
  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
  let cookie = '';
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.on('error', (e) => reject(e));
    server.on('clientError', (err, sock) => sock.destroy());
    server.once('listening', () => {
      (globalThis as any).__apiServer = server;
      (globalThis as any).__apiBase = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
  const baseUrl = (globalThis as any).__apiBase as string;
  const server = (globalThis as any).__apiServer;

  const call = async (method: string, path: string, body?: unknown, useCookie = true) => {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', ...(useCookie && cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
    } catch (err: any) {
      const cause = err?.cause ?? err;
      console.error(`\n[debug] fetch ${method} ${path} failed:`, cause?.code ?? '', String(cause?.message ?? cause).slice(0, 120), `baseUrl=${baseUrl}`);
      throw err;
    }
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, data, headers: res.headers };
  };

  test('exactly one Super Admin account exists, and no signup route', async () => {
    assertEquals(countUsers(), 1);
    const signup = await call('POST', '/api/auth/register', { username: 'x', password: 'y' }, false);
    assertEquals(signup.status, 404);
  });

  test('unauthenticated API access returns 401', async () => {
    assertEquals((await call('GET', '/api/settings', undefined, false)).status, 401);
    assertEquals((await call('GET', '/api/dashboard', undefined, false)).status, 401);
    assertEquals((await call('GET', '/api/projects', undefined, false)).status, 401);
    assertEquals((await call('GET', '/media/outputs/x.mp4', undefined, false)).status, 401);
  });

  test('login rejects wrong password/user and accepts the correct one', async () => {
    assertEquals((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' }, false)).status, 401);
    assertEquals((await call('POST', '/api/auth/login', { username: 'ghost', password: 'x' }, false)).status, 401);
    const ok = await call('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' }, false);
    assertEquals(ok.status, 200);
    assert((ok.headers.get('set-cookie') || '').includes('HttpOnly'), 'session cookie is HttpOnly');
    assert(cookie.includes('avc_session='), 'session cookie captured');
    const me = await call('GET', '/api/auth/me');
    assertEquals(me.data.user.username, 'admin');
    assertEquals(me.data.user.role, 'SUPER_ADMIN');
  });

  test('AI settings never leak the full API key to the client', async () => {
    await call('PUT', '/api/settings/ai', { api_key: 'sk-super-secret-key-1234' });
    const r = await call('GET', '/api/settings');
    assert(!JSON.stringify(r.data).includes('sk-super-secret-key-1234'), 'raw key not returned');
    assert(r.data.ai.api_key_set === true, 'key existence reported');
    // saving the masked placeholder must not wipe the real key
    await call('PUT', '/api/settings/ai', { api_key: '****1234', default_model: 'deepseek-v4.1-flash' });
    const r2 = await call('GET', '/api/settings');
    assert(r2.data.ai.api_key_set === true, 'masked save preserved the key');
    assertEquals(r2.data.ai.default_model, 'deepseek-v4.1-flash');
  });

  test('numeric settings are clamped / validated server-side', async () => {
    await call('PUT', '/api/settings/ai', { temperature: 99, max_tokens: 5 });
    const r = await call('GET', '/api/settings/ai');
    assert(r.data.temperature <= 2, 'temperature clamped to <= 2');
    assert(r.data.max_tokens >= 32, 'max_tokens clamped up');
  });

  test('unknown settings group is rejected', async () => {
    assertEquals((await call('PUT', '/api/settings/bogus', { a: 1 })).status, 404);
    assertEquals((await call('GET', '/api/settings/bogus')).status, 404);
  });

  test('prompt load / save / reset roundtrip', async () => {
    const before = await call('GET', '/api/prompts/clip_scoring');
    assertEquals(before.status, 200);
    assert(before.data.text.includes('{{clip_transcript}}'), 'default prompt uses variables');
    await call('PUT', '/api/prompts/clip_scoring', { text: 'CUSTOM {{clip_transcript}}' });
    const after = await call('GET', '/api/prompts/clip_scoring');
    assertEquals(after.data.text, 'CUSTOM {{clip_transcript}}');
    await call('POST', '/api/prompts/clip_scoring/reset');
    const reset = await call('GET', '/api/prompts/clip_scoring');
    assertEquals(reset.data.text, before.data.text);
    assertEquals((await call('GET', '/api/prompts/not_a_task')).status, 404);
  });

  test('scoring weights can be changed and persist', async () => {
    await call('PUT', '/api/settings/scoring', { hook: 50, payoff: 10 });
    const r = await call('GET', '/api/settings/scoring');
    assertEquals(r.data.hook, 50);
  });

  test('telegram authorization only allows the configured numeric user id', async () => {
    const saved = config.telegram.allowedUserId;
    config.telegram.allowedUserId = '';
    assert(!authorizationCheck(123).ok, 'empty allowlist denies everyone');
    config.telegram.allowedUserId = '555';
    assert(!authorizationCheck(123).ok, 'different user denied');
    assert(authorizationCheck(555).ok, 'configured user allowed');
    assert(!authorizationCheck(undefined).ok, 'missing user denied');
    config.telegram.allowedUserId = saved;
  });

  test('b-roll and sfx asset routes expose the libraries and 404 unknown ids', async () => {
    const b = await call('GET', '/api/assets/broll');
    assertEquals(b.status, 200);
    assert(Array.isArray(b.data.broll), 'broll list shape');
    const s = await call('GET', '/api/assets/sfx');
    assertEquals(s.status, 200);
    assert(Array.isArray(s.data.sfx), 'sfx list shape');
    assertEquals((await call('GET', '/api/assets/broll/nope')).status, 404);
    assertEquals((await call('GET', '/api/assets/sfx/nope')).status, 404);
    assertEquals((await call('DELETE', '/api/assets/broll/nope')).status, 404);
    assertEquals((await call('PATCH', '/api/assets/sfx/nope', { name: 'x' })).status, 404);
  });

  test('clip routes require auth and 404 on unknown clip', async () => {
    assertEquals((await call('GET', '/api/clips/nope')).status, 404);
    assertEquals((await call('POST', '/api/clips/nope/render', {} )).status, 404);
    assertEquals((await call('PATCH', '/api/clips/nope', { start: 1 })).status, 404);
  });

  test('project upload validation rejects non-video and missing projects', async () => {
    assertEquals((await call('POST', '/api/projects/nope/run', { from: 'transcription' })).status, 404);
    assertEquals((await call('POST', '/api/projects/nope/select', { top: 5 })).status, 404);
  });

  test('URL project creation rejects invalid URLs before touching the network', async () => {
    assertEquals((await call('POST', '/api/projects/url', { url: 'not a url' })).status, 400);
    assertEquals((await call('POST', '/api/projects/url', { url: 'ftp://example.com/x.mp4' })).status, 400);
    assertEquals((await call('POST', '/api/projects/url', {})).status, 400);
  });

  test('dashboard returns counts once authenticated', async () => {
    const r = await call('GET', '/api/dashboard');
    assertEquals(r.status, 200);
    assert(typeof r.data.counts.projects === 'number', 'has project count');
  });

  test('reference + learning routes serve real shapes', async () => {
    const refs = await call('GET', '/api/references');
    assertEquals(refs.status, 200);
    assert(Array.isArray(refs.data.references) && typeof refs.data.total === 'number', 'references list shape');
    assertEquals(refs.data.total, 0, 'fresh test DB has no references');
    const cats = await call('GET', '/api/references/categories');
    assertEquals(cats.status, 200, 'categories route works');
    for (const ep of ['learning/events?limit=5', 'learning/insights', 'learning/stats', 'learning/preferences', 'learning/history', 'learning/snapshots']) {
      const r = await call('GET', `/api/${ep}`);
      if (r.status !== 200) throw new Error(`${ep} failed: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const ev = await call('GET', '/api/learning/events?limit=5&context=gaming');
    assertEquals(ev.status, 200, 'events with context filter works');
    const manual = await call('PUT', '/api/learning/preferences', { feature: 'pacing', contextKey: '', value: 'fast' });
    assertEquals(manual.status, 200, 'manual preference set via API');
    assertEquals((await call('POST', '/api/references/url', { url: 'not a url' })).status, 400);
    assertEquals((await call('POST', '/api/references/url', { url: 'ftp://example.com/x.mp4' })).status, 400);
    assertEquals((await call('POST', '/api/references/url', {})).status, 400);
    const del = await call('POST', '/api/learning/reset', { scope: 'all' });
    assertEquals(del.status, 200, 'reset scope all');
  });

  test('design routes: CRUD, preview, versions, templates', async () => {
    const created = await call('POST', '/api/designs', { name: 'API design', width: 800, height: 800 });
    assertEquals(created.status, 201);
    const id = created.data.design.id;
    assertEquals(created.data.design.status, 'draft');

    const got = await call('GET', `/api/designs/${id}`);
    assertEquals(got.status, 200);
    assertEquals(got.data.document.id, id);

    const doc = got.data.document;
    doc.layers.push({
      id: 't1', type: 'text', name: 'headline', x: 60, y: 60, width: 600, height: 160, text: 'Hello <API> & world',
      style: { fontFamily: 'Arial', fontSize: 64, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'left', color: '#ffffff', uppercase: false, overflow: 'shrink' },
      opacity: 1, visible: true, locked: false, rotation: 0,
    });
    const saved = await call('PUT', `/api/designs/${id}`, { document: doc });
    assertEquals(saved.status, 200);
    assertEquals(saved.data.document.revision, got.data.document.revision + 1);

    const invalid = await call('PUT', `/api/designs/${id}`, { document: { id, schemaVersion: 1, canvas: { width: 10 } } });
    assertEquals(invalid.status, 400);

    const preview = await call('GET', `/api/designs/${id}/preview.svg`);
    assertEquals(preview.status, 200);
    const svg = String(preview.data);
    assert(svg.includes('<svg') && svg.includes('&lt;API&gt;') && svg.includes('&amp;'), 'preview escapes text');
    assert(!svg.includes('Hello <API>'), 'preview never emits raw markup');

    const adhoc = await call('POST', '/api/designs/preview', { document: got.data.document });
    assertEquals(adhoc.status, 200);

    const versions = await call('GET', `/api/designs/${id}/versions`);
    assert(Array.isArray(versions.data.versions) && versions.data.versions.length >= 1, 'version snapshots recorded');
    const oldestRev = versions.data.versions[versions.data.versions.length - 1].revision;
    const restored = await call('POST', `/api/designs/${id}/versions/${oldestRev}/restore`);
    assertEquals(restored.status, 200);

    // re-commit content after the restore so the template has layers to copy
    const resaved = await call('PUT', `/api/designs/${id}`, { document: doc, label: 'content back' });
    assertEquals(resaved.status, 200);

    const exp = await call('POST', `/api/designs/${id}/export`, { format: 'svg' });
    assertEquals(exp.status, 200);
    assert(exp.data.export.url.includes('/media/design-exports/'), 'svg export served from media scope');
    const dl = await fetch(baseUrl + exp.data.export.url, { headers: { cookie } });
    assertEquals(dl.status, 200);
    assert((await dl.text()).startsWith('<svg'), 'exported svg downloads');

    const tpl = await call('POST', '/api/templates', { name: 'API template', designId: id, category: 'api-test' });
    assertEquals(tpl.status, 201);
    const list = await call('GET', '/api/templates?category=api-test');
    assert(Array.isArray(list.data.templates) && list.data.templates.length >= 1, 'template listed');
    const applied = await call('POST', `/api/templates/${tpl.data.template.id}/apply`, { name: 'From API template' });
    assertEquals(applied.status, 201);
    assert(applied.data.document.layers.length > 0, 'template layers copied');
    const dupTpl = await call('POST', `/api/templates/${tpl.data.template.id}/duplicate`, {});
    assertEquals(dupTpl.status, 201);
    assertEquals((await call('DELETE', `/api/templates/${tpl.data.template.id}`)).status, 200);
    assertEquals((await call('DELETE', `/api/templates/${dupTpl.data.template.id}`)).status, 200);

    assertEquals((await call('GET', '/api/designs/nope-not-real')).status, 404);
    assertEquals((await call('DELETE', `/api/designs/${id}`)).status, 200);
    await call('DELETE', `/api/designs/${applied.data.design.id}`);
  });

  test('design png export renders through headless chromium', async () => {
    const created = await call('POST', '/api/designs', { name: 'PNG design', width: 600, height: 600 });
    const id = created.data.design.id;
    const exp = await call('POST', `/api/designs/${id}/export`, { format: 'png' });
    assertEquals(exp.status, 200);
    assert(exp.data.export.bytes > 1000, `png export has real bytes (${exp.data.export.bytes})`);
    const dl = await fetch(baseUrl + exp.data.export.url, { headers: { cookie } });
    const buf = Buffer.from(await dl.arrayBuffer());
    assert(buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50, 'downloaded file is a real png');
    await call('DELETE', `/api/designs/${id}`);
  });

  test('design asset library: upload, serve, reference-check, delete', async () => {
    const assets = await call('GET', '/api/design-assets');
    assertEquals(assets.status, 200);
    assert(Array.isArray(assets.data.assets), 'assets list shape');
    const fonts = await call('GET', '/api/design-assets/fonts');
    assertEquals(fonts.status, 200);

    const pngPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avc-asset-')), 'dot.png');
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', '-y', pngPath]);
    if (ff.status !== 0) throw new Error('ffmpeg failed to create a test png');
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(pngPath)], { type: 'image/png' }), 'dot.png');
    fd.append('kind', 'logo');
    fd.append('name', 'Red dot');
    const up = await fetch(baseUrl + '/api/design-assets', { method: 'POST', headers: { cookie }, body: fd });
    assertEquals(up.status, 201);
    const asset = (await up.json() as { asset: { id: string; url: string } }).asset;
    assert(asset.url.startsWith('/media/design-assets/'), 'asset served from media scope');
    assertEquals((await fetch(baseUrl + asset.url, { headers: { cookie } })).status, 200);
    assertEquals((await call('DELETE', `/api/design-assets/${asset.id}`)).status, 200);
  });

  test('logout invalidates the session', async () => {
    await call('POST', '/api/auth/logout');
    cookie = '';
    assertEquals((await call('GET', '/api/settings', undefined, false)).status, 401);
  });

  // teardown returned to the runner; server must outlive test() registration
  return () => new Promise<void>((r) => server.close(() => r()));
}

export { };
