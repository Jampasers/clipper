import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runCmd } from './ffmpeg.js';
import { q } from './sqlite.js';
import { aiHealth } from './ai.js';
import { queueStats } from './queue.js';

export interface HealthItem {
  name: string;
  ok: boolean;
  detail: string;
  error?: string;
}

async function checkFfmpeg(bin: string): Promise<HealthItem> {
  const { code, stdout, stderr } = await runCmd(bin, ['-version']);
  if (code === 0 && /ffmpeg|ffprobe/i.test(stdout)) {
    const version = stdout.split('\n')[0].slice(0, 80);
    return { name: bin === config.ffprobe ? 'FFprobe' : 'FFmpeg', ok: true, detail: version };
  }
  return { name: bin === config.ffprobe ? 'FFprobe' : 'FFmpeg', ok: false, detail: 'not found', error: `Could not run "${bin}". Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH. ${stderr.slice(0, 120)}` };
}

async function checkWhisper(): Promise<HealthItem> {
  const { code, stdout, stderr } = await runCmd(config.python, ['-c', 'import faster_whisper, sys; print(faster_whisper.__version__)']);
  if (code === 0) return { name: 'Whisper', ok: true, detail: `faster-whisper ${stdout.trim()} (model: ${config.whisper.model})` };
  return { name: 'Whisper', ok: false, detail: 'not installed', error: `python -m pip install --user faster-whisper. ${stderr.slice(0, 160)}` };
}

async function checkOpencv(): Promise<HealthItem> {
  // Must verify the cascade API actually works (partial/broken cv2 installs import fine
  // but lack CascadeClassifier, which silently degrades reframe to a center crop).
  const probe = 'import cv2; c = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml"); assert not c.empty(); print(cv2.__version__)';
  const { code, stdout, stderr } = await runCmd(config.python, ['-c', probe]);
  if (code === 0) return { name: 'OpenCV (reframe)', ok: true, detail: `cv2 ${stdout.trim()} (cascade ok)` };
  return { name: 'OpenCV (reframe)', ok: false, detail: 'not installed or broken', error: `python -m pip install --user --force-reinstall opencv-python-headless numpy. Face tracking falls back to center crop. ${stderr.slice(0, 120)}` };
}

function checkDatabase(): HealthItem {
  try {
    const row = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return { name: 'Database', ok: true, detail: `SQLite OK, ${row?.n ?? 0} user(s)` };
  } catch (err: any) {
    return { name: 'Database', ok: false, detail: 'unavailable', error: String(err?.message || err) };
  }
}

function checkStorage(): HealthItem {
  const problems: string[] = [];
  for (const [name, dir] of Object.entries(config.dirs)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err: any) {
      problems.push(`${name}: ${err?.message}`);
    }
  }
  if (problems.length) return { name: 'Storage', ok: false, detail: 'not writable', error: problems.join('; ') };
  return { name: 'Storage', ok: true, detail: Object.keys(config.dirs).length + ' dirs writable' };
}

function checkTelegram(): HealthItem {
  if (!config.telegram.token) return { name: 'Telegram', ok: true, detail: 'bot not configured (token empty)' };
  if (!config.telegram.allowedUserId) return { name: 'Telegram', ok: false, detail: 'token set but TELEGRAM_ALLOWED_USER_ID missing', error: 'Set TELEGRAM_ALLOWED_USER_ID to your numeric Telegram user id.' };
  return { name: 'Telegram', ok: true, detail: `configured for user ${config.telegram.allowedUserId}` };
}

function checkQueue(): HealthItem {
  const stats = queueStats();
  const ok = stats.driver === 'sqlite' || stats.driver === 'redis';
  return { name: 'Queue', ok, detail: `${stats.driver} — ${stats.queued} queued, ${stats.running} running, ${stats.failed} failed` };
}

export async function runHealthChecks(): Promise<{ ok: boolean; items: HealthItem[]; checkedAt: string }> {
  const [database, router, ffmpeg, ffprobe, whisper, opencv] = await Promise.all([
    Promise.resolve(checkDatabase()),
    aiHealth().then((r): HealthItem => ({ name: '9Router', ok: r.ok, detail: r.ok ? `${r.models_count ?? 0} models available` : 'unreachable', error: r.error })),
    checkFfmpeg(config.ffmpeg),
    checkFfmpeg(config.ffprobe),
    checkWhisper(),
    checkOpencv(),
  ]);
  const items: HealthItem[] = [
    database, router, ffmpeg, ffprobe, whisper, opencv,
    checkQueue(), checkTelegram(), checkStorage(),
  ];
  return { ok: items.every((i) => i.ok), items, checkedAt: new Date().toISOString() };
}

/** Local audio/video sanity for the render engine (used by the health page too). */
export function storageRoot(): string {
  return path.dirname(config.dirs.input);
}
