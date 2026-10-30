/* API tests: auth, settings, prompts, authorization, validation — against a real
 * in-process Express app with the shared test DB. */
import { test, assert, assertEquals } from './runner.js';
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

  test('logout invalidates the session', async () => {
    await call('POST', '/api/auth/logout');
    cookie = '';
    assertEquals((await call('GET', '/api/settings', undefined, false)).status, 401);
  });

  // teardown returned to the runner; server must outlive test() registration
  return () => new Promise<void>((r) => server.close(() => r()));
}

export { };
