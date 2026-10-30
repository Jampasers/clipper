import OpenAI from 'openai';
import { getSettings } from './settings.js';
import { getPrompt, type PromptTask } from './prompts.js';
import { logger } from './log.js';

/** OpenAI-compatible client pointed at 9Router. Keys never leave the backend. */

export type AiTask =
  | 'content_analysis'
  | 'highlight_detection'
  | 'clip_scoring'
  | 'clip_boundary'
  | 'title_generation'
  | 'subtitle_analysis';

export class AiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function makeClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({
    baseURL: baseUrl.replace(/\/+$/, ''),
    apiKey: apiKey || 'not-set',
    maxRetries: 0, // we handle retries ourselves for logging
    timeout: getSettings('ai').timeout_ms,
  });
}

export function modelForTask(task: AiTask): { model: string; fallback: string } {
  const ai = getSettings('ai');
  const model = ai.routing?.[task] || ai.default_model;
  return { model, fallback: ai.fallback_model };
}

export interface AiResult<T = unknown> {
  raw: string;
  json: T;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function chat(taskHint: string, model: string, messages: OpenAI.ChatCompletionMessageParam[]): Promise<{ raw: string; usage?: any }> {
  const ai = getSettings('ai');
  const client = makeClient(ai.base_url, ai.api_key);
  const started = Date.now();
  try {
    const res = await client.chat.completions.create({
      model,
      messages,
      temperature: ai.temperature,
      max_tokens: ai.max_tokens,
      stream: false,
    });
    const raw = res.choices?.[0]?.message?.content ?? '';
    logger.debug('AI', `${taskHint}: model=${model} ${Date.now() - started}ms ${res.usage?.total_tokens ?? '?'} tokens`);
    return { raw, usage: res.usage };
  } catch (err: any) {
    const msg = err?.error?.error?.message || err?.message || 'unknown ai error';
    const status = err?.status ?? 500;
    logger.warn('AI', `${taskHint}: model=${model} failed (${status}): ${String(msg).slice(0, 300)}`);
    throw new AiError(msg, status >= 400 && status < 600 ? status : 502);
  }
}

async function chatWithRetry(taskHint: string, model: string, messages: OpenAI.ChatCompletionMessageParam[]): Promise<{ raw: string; usage?: any }> {
  const ai = getSettings('ai');
  const retries = Math.max(0, ai.request_retries);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chat(taskHint, model, messages);
    } catch (err) {
      lastErr = err;
      const status = err instanceof AiError ? err.status : 500;
      const retriable = status === 429 || status >= 500;
      if (!retriable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Generate with a task's routed model + prompt template. */
export async function generate<T = unknown>(
  task: AiTask,
  variables: Record<string, unknown>,
  extraSystem?: string
): Promise<AiResult<T>> {
  const { model } = modelForTask(task);
  const prompt = renderUserPrompt(task, variables);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(extraSystem ? [{ role: 'system' as const, content: extraSystem }] : []),
    { role: 'user' as const, content: prompt },
  ];

  const tryModel = async (m: string): Promise<AiResult<T>> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { raw, usage } = await chatWithRetry(task, m, messages);
        return { raw, json: extractJson<T>(raw), model: m, usage };
      } catch (err) {
        lastErr = err;
        const status = err instanceof AiError ? err.status : 500;
        if (status === 401 || status === 403) throw err; // auth: no point retrying
      }
    }
    throw lastErr;
  };

  try {
    return await tryModel(model);
  } catch (err) {
    const { fallback } = modelForTask(task);
    if (fallback && fallback !== model) {
      logger.warn('AI', `${task}: falling back to ${fallback}`);
      return await tryModel(fallback);
    }
    throw err;
  }
}

export function renderUserPrompt(task: PromptTask, variables: Record<string, unknown>): string {
  const template = getPrompt(task);
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    const v = variables[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Close an unterminated JSON fragment (open strings/brackets); null if unfixable. */
function closeJson(text: string): string | null {
  const scan = (s: string) => {
    let inStr = false;
    let esc = false;
    const stack: string[] = [];
    for (const c of s) {
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') {
        if (stack.pop() !== c) return { ok: false, stack, inStr };
      }
    }
    return { ok: true, stack, inStr };
  };

  for (let attempt = 0; attempt < 50; attempt++) {
    const { ok, stack, inStr } = scan(text);
    if (!ok) return null;
    let out = text.replace(/[\s,]+$/, '');
    // drop a dangling `"key":` (value missing) back to the previous comma
    if (inStr || /"[^"]*"\s*:\s*$/.test(out) || out.endsWith(':')) {
      const lastDelim = Math.max(out.lastIndexOf(','), out.lastIndexOf('{'), out.lastIndexOf('['));
      if (lastDelim >= 0) out = out.slice(0, lastDelim).replace(/[\s,]+$/, '');
    } else if (inStr) {
      out += '"';
    }
    let fixed = out;
    const st = scan(fixed);
    if (st.inStr) fixed += '"';
    while (st.stack.length) fixed += st.stack.pop();
    try {
      JSON.parse(fixed);
      return fixed;
    } catch {
      const cut = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (cut <= 0) return null;
      text = text.slice(0, cut + 1);
    }
  }
  return null;
}

/** Tolerant JSON extraction: strips code fences, finds the first JSON object/array. */
export function extractJson<T = unknown>(raw: string): T {
  if (!raw) throw new AiError('AI returned empty response', 502);
  let text = raw.trim();  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through to brace scanning */
  }
  const start = text.search(/[[{]/);
  if (start === -1) throw new AiError(`AI response is not JSON: ${text.slice(0, 200)}`, 502);
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch (e) {
          throw new AiError(`AI returned malformed JSON: ${(e as Error).message.slice(0, 200)} | ${slice.slice(0, 200)}`, 502);
        }
      }
    }
  }
  // truncated response: walk back to the last complete value and re-close
  let slice = text.slice(start);
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = closeJson(slice);
    if (candidate !== null) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        /* fall through */
      }
    }
    const cut = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (cut <= 0) break;
    slice = slice.slice(0, cut + 1).replace(/[\s,]+$/, '');
  }
  throw new AiError('AI response contains unterminated JSON', 502);
}

/* ---- health/test helpers ---- */

export async function listModels(): Promise<string[]> {
  const ai = getSettings('ai');
  const client = makeClient(ai.base_url, ai.api_key);
  try {
    const res = await client.models.list();
    const ids: string[] = [];
    for await (const m of res) ids.push(m.id);
    return ids.sort();
  } catch (err: any) {
    throw new AiError(err?.message || 'Could not list models', 502);
  }
}

export async function testConnection(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    return { ok: true, models: await listModels() };
  } catch (err: any) {
    return { ok: false, models: [], error: err?.message || String(err) };
  }
}

export async function testModel(model: string): Promise<{ ok: boolean; reply?: string; error?: string }> {
  try {
    const { raw } = await chat('test-model', model, [{ role: 'user', content: 'Reply with exactly: OK' }]);
    return { ok: true, reply: raw.trim().slice(0, 100) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function aiHealth(): Promise<{ ok: boolean; error?: string; models_count?: number }> {
  try {
    const models = await listModels();
    return { ok: true, models_count: models.length };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}
