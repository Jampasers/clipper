import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(process.cwd());

function dir(envVal: string | undefined, fallback: string): string {
  const p = envVal ? path.resolve(ROOT, envVal) : path.resolve(ROOT, fallback);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me-32b-minimum!!',
  sessionTtlDays: 7,
  dbName: path.resolve(ROOT, process.env.DATABASE_URL || './data/app.db'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  ai: {
    baseUrl: process.env.AI_BASE_URL || 'http://localhost:20128/v1',
    apiKey: process.env.AI_API_KEY || process.env.ROUTER_API_KEY || '',
    defaultModel: process.env.AI_DEFAULT_MODEL || 'rv/deepseek-ai/DeepSeek-V4.1-Flash',
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID || '',
  },

  dirs: {
    input: dir(process.env.INPUT_DIR, './storage/inputs'),
    project: dir(process.env.PROJECT_DIR, './storage/projects'),
    temp: dir(process.env.TEMP_DIR, './storage/temp'),
    preview: dir(process.env.PREVIEW_DIR, './storage/previews'),
    output: dir(process.env.OUTPUT_DIR, './storage/outputs'),
  },

  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  python: process.env.PYTHON_PATH || 'python',
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  ytdlpMaxHeight: parseInt(process.env.YTDLP_MAX_HEIGHT || '1080', 10),
  whisper: {
    model: process.env.WHISPER_MODEL || 'base',
    device: process.env.WHISPER_DEVICE || 'cpu',
    computeType: process.env.WHISPER_COMPUTE_TYPE || 'int8',
  },
  queueDriver: (process.env.QUEUE_DRIVER || 'sqlite') as 'sqlite' | 'redis',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};

export { ROOT };
