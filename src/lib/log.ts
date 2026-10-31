import { q } from './sqlite.js';

export const LOG_CATEGORIES = [
  'AUTH',
  'AI',
  'TRANSCRIPTION',
  'VIDEO',
  'RENDER',
  'REVIEW',
  'CAPTION',
  'TELEGRAM',
  'QUEUE',
  'SYSTEM',
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_RE = /(api[_-]?key|token|password|secret|authorization)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi;

export function redact(msg: string): string {
  return msg.replace(SENSITIVE_RE, '$1$2***(redacted)');
}

export function log(category: LogCategory, level: LogLevel, message: string, meta?: unknown) {
  const line = `[${new Date().toISOString()}] [${category}] [${level.toUpperCase()}] ${redact(message)}`;
  if (level === 'error') console.error(line, meta !== undefined ? redact(String(meta)) : '');
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    q.run(
      'INSERT INTO logs (level, category, message, meta) VALUES (?,?,?,?)',
      level,
      category,
      redact(String(message)).slice(0, 4000),
      meta !== undefined ? JSON.stringify(meta).slice(0, 4000) : null
    );
  } catch {
    /* db not ready yet — console only */
  }
}

export const logger = {
  debug: (c: LogCategory, m: string, meta?: unknown) => log(c, 'debug', m, meta),
  info: (c: LogCategory, m: string, meta?: unknown) => log(c, 'info', m, meta),
  warn: (c: LogCategory, m: string, meta?: unknown) => log(c, 'warn', m, meta),
  error: (c: LogCategory, m: string, meta?: unknown) => log(c, 'error', m, meta),
};
