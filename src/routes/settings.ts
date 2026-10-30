import { Router } from 'express';
import { requireAuth } from '../lib/middleware.js';
import {
  getAllSettings, setSettings, getSettings, maskApiKey, type SettingsGroup,
} from '../lib/settings.js';
import { getPromptRows, savePrompt, resetPrompt, getPrompt, PROMPT_TASKS, DEFAULT_PROMPTS, renderPrompt, promptVariables } from '../lib/prompts.js';
import { testConnection, testModel, listModels, modelForTask } from '../lib/ai.js';
import { runHealthChecks } from '../lib/health.js';
import { q } from '../lib/sqlite.js';
import { queueStats, listJobs, retryJob } from '../lib/queue.js';
import { logger } from '../lib/log.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const GROUPS: SettingsGroup[] = ['ai', 'clipping', 'scoring', 'subtitles', 'reframe', 'render', 'telegram', 'pipeline'];

function publicAiSettings() {
  const ai = getSettings('ai');
  return { ...ai, api_key: maskApiKey(ai.api_key), api_key_set: !!ai.api_key };
}

settingsRouter.get('/', (_req, res) => {
  const all = getAllSettings();
  res.json({
    ai: publicAiSettings(),
    clipping: all.clipping,
    scoring: all.scoring,
    subtitles: all.subtitles,
    reframe: all.reframe,
    render: all.render,
    telegram: all.telegram,
    pipeline: all.pipeline,
    routing: all.ai.routing,
  });
});

settingsRouter.get('/:group', (req, res) => {
  const group = req.params.group as SettingsGroup;
  if (!GROUPS.includes(group)) return res.status(404).json({ error: 'unknown settings group' });
  if (group === 'ai') return res.json(publicAiSettings());
  res.json(getSettings(group));
});

settingsRouter.put('/:group', (req, res) => {
  const group = req.params.group as SettingsGroup;
  if (!GROUPS.includes(group)) return res.status(404).json({ error: 'unknown settings group' });
  const body = { ...(req.body ?? {}) } as Record<string, unknown>;
  if (group === 'ai') {
    // never accept the masked placeholder back as a real key
    if (typeof body.api_key === 'string' && /^\*+/.test(body.api_key)) delete body.api_key;
    delete body.api_key_set;
    validateAiPatch(body);
  }
  if (group === 'scoring' || group === 'clipping' || group === 'render') validateNumbers(group, body);
  const updated = setSettings(group, body);
  logger.info('SYSTEM', `settings updated: ${group}`);
  if (group === 'ai') return res.json(publicAiSettings());
  res.json(updated);
});

function validateAiPatch(body: Record<string, unknown>) {
  if (body.temperature !== undefined) body.temperature = clamp(Number(body.temperature), 0, 2);
  if (body.max_tokens !== undefined) body.max_tokens = Math.round(clamp(Number(body.max_tokens), 32, 200000));
  if (body.timeout_ms !== undefined) body.timeout_ms = Math.round(clamp(Number(body.timeout_ms), 1000, 600000));
  if (body.request_retries !== undefined) body.request_retries = Math.round(clamp(Number(body.request_retries), 0, 5));
  if (typeof body.base_url === 'string' && body.base_url && !/^https?:\/\//.test(body.base_url)) {
    body.base_url = `http://${body.base_url}`;
  }
}
function validateNumbers(group: string, body: Record<string, unknown>) {
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'number' && !Number.isFinite(v)) throw Object.assign(new Error(`${group}.${k} must be finite`), { status: 400 });
  }
}
function clamp(n: number, a: number, b: number) { return Math.min(b, Math.max(a, Number.isFinite(n) ? n : a)); }

/* ---- AI instance tests ---- */

settingsRouter.post('/ai/test', async (_req, res, next) => {
  try {
    const result = await testConnection();
    logger.info('AI', `connection test: ${result.ok ? 'ok' : 'failed'}`);
    res.json(result);
  } catch (e) { next(e); }
});

settingsRouter.post('/ai/test-model', async (req, res, next) => {
  try {
    const model = String(req.body?.model ?? '').trim();
    if (!model) return res.status(400).json({ error: 'model required' });
    const result = await testModel(model);
    res.json(result);
  } catch (e) { next(e); }
});

settingsRouter.get('/ai/models', async (_req, res, next) => {
  try {
    const models = await listModels();
    res.json({ models });
  } catch (e: any) {
    res.status(502).json({ error: String(e?.message || e), models: [] });
  }
});

settingsRouter.get('/ai/routing', (_req, res) => {
  const tasks = ['highlight_detection', 'clip_scoring', 'clip_boundary', 'title_generation', 'subtitle_analysis', 'content_analysis'] as const;
  res.json(Object.fromEntries(tasks.map((t) => [t, modelForTask(t)])));
});

/* ---- prompts ---- */

export const promptsRouter = Router();
promptsRouter.use(requireAuth);

promptsRouter.get('/', (_req, res) => {
  res.json({
    prompts: getPromptRows(),
    tasks: PROMPT_TASKS,
    defaults: DEFAULT_PROMPTS,
  });
});

promptsRouter.get('/:task', (req, res) => {
  const task = req.params.task as (typeof PROMPT_TASKS)[number];
  if (!PROMPT_TASKS.includes(task)) return res.status(404).json({ error: 'unknown prompt' });
  const text = getPrompt(task);
  res.json({ task, text, default: DEFAULT_PROMPTS[task], variables: promptVariables(text) });
});

promptsRouter.put('/:task', (req, res) => {
  const task = req.params.task as (typeof PROMPT_TASKS)[number];
  if (!PROMPT_TASKS.includes(task)) return res.status(404).json({ error: 'unknown prompt' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'prompt text required' });
  savePrompt(task, text);
  logger.info('SYSTEM', `prompt updated: ${task}`);
  res.json({ ok: true, task, text: getPrompt(task) });
});

promptsRouter.post('/:task/reset', (req, res) => {
  const task = req.params.task as (typeof PROMPT_TASKS)[number];
  if (!PROMPT_TASKS.includes(task)) return res.status(404).json({ error: 'unknown prompt' });
  resetPrompt(task);
  res.json({ ok: true, task, text: DEFAULT_PROMPTS[task] });
});

promptsRouter.post('/:task/test', async (req, res, next) => {
  try {
    const task = req.params.task as (typeof PROMPT_TASKS)[number];
    if (!PROMPT_TASKS.includes(task)) return res.status(404).json({ error: 'unknown prompt' });
    const vars = (req.body?.variables ?? {}) as Record<string, unknown>;
    const rendered = renderPrompt(getPrompt(task), vars);
    const { chat } = await import('../lib/ai.js');
    const model = String(req.body?.model ?? '').trim() || getSettings('ai').default_model;
    const out = await chat(`prompt-test:${task}`, model, [{ role: 'user', content: rendered }]);
    res.json({ ok: true, model, rendered, output: out.raw.slice(0, 4000) });
  } catch (e) { next(e); }
});

/* ---- system ---- */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const systemRouter = Router();
systemRouter.use(requireAuth);

systemRouter.get('/health', async (_req, res, next) => {
  try {
    res.json(await runHealthChecks());
  } catch (e) { next(e); }
});

systemRouter.get('/logs', (req, res) => {
  const level = req.query.level as string | undefined;
  const category = req.query.category as string | undefined;
  const limit = Math.min(500, parseInt(String(req.query.limit || '200'), 10) || 200);
  const where: string[] = [];
  const args: any[] = [];
  if (level) { where.push('level = ?'); args.push(level); }
  if (category) { where.push('category = ?'); args.push(category); }
  args.push(limit);
  const rows = q.all(`SELECT id, ts, level, category, message FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...args);
  res.json({ logs: rows });
});

systemRouter.get('/workers', (_req, res) => {
  res.json({ queue: queueStats(), jobs: listJobs(60) });
});

systemRouter.post('/workers/:id/retry', (req, res) => {
  res.json({ ok: retryJob(String(req.params.id)) });
});

systemRouter.get('/storage', (_req, res) => {
  const entries = Object.entries(config.dirs).map(([name, dir]) => ({ name, path: dir, size: dirSizeSync(dir) }));
  res.json({ dirs: entries, total: entries.reduce((a, e) => a + e.size, 0) });
});

function dirSizeSync(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeSync(full);
    else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
  }
  return total;
}
