/* Shared test bootstrap: isolates DB + storage into a temp dir BEFORE any
 * source module reads the environment. Import this first in run.ts. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cwd = process.cwd();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-test-'));

process.env.TEMP = base;
process.env.DATABASE_URL = path.join(base, 'test.db');
process.env.INPUT_DIR = path.join(base, 'inputs');
process.env.PROJECT_DIR = path.join(base, 'projects');
process.env.TEMP_DIR = path.join(base, 'temp');
process.env.PREVIEW_DIR = path.join(base, 'previews');
process.env.OUTPUT_DIR = path.join(base, 'outputs');
process.env.ASSET_DIR = path.join(base, 'assets');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'testpass123';
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456';
process.env.WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';

export const TEST_BASE = base;
export function tempName(name: string): string {
  const p = path.join(base, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
