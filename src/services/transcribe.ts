import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { q } from '../lib/sqlite.js';
import { runCmd } from '../lib/ffmpeg.js';
import { logger } from '../lib/log.js';
import type { MediaProbe } from '../lib/ffmpeg.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: { start: number; end: number; word: string }[];
}

export interface TranscriptData {
  model: string;
  language: string;
  duration: number;
  segments: TranscriptSegment[];
  text: string;
}

function audioPath(projectId: string): string {
  return path.join(config.dirs.project, projectId, 'audio16k.wav');
}

/** Extract 16kHz mono wav once, reuse for reruns. */
async function ensureWav(projectId: string, sourcePath: string, probe: MediaProbe): Promise<string> {
  const wav = audioPath(projectId);
  if (fs.existsSync(wav) && fs.statSync(wav).size > 1000) return wav;
  if (fs.existsSync(wav)) fs.unlinkSync(wav);
  if (!probe.hasAudio) throw new Error('Video has no audio stream; cannot transcribe.');
  const tempWav = `${wav}.tmp.wav`;
  const { code, stderr } = await runCmd(config.ffmpeg, [
    '-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tempWav,
  ]);
  if (code !== 0) throw new Error(`Audio extraction failed: ${stderr.slice(-400)}`);
  fs.renameSync(tempWav, wav);
  return wav;
}

type ProgressFn = (p: number) => void;

export async function transcribeProject(projectId: string, sourcePath: string, probe: MediaProbe, onProgress: ProgressFn): Promise<TranscriptData> {
  const pipeline = getSettings('pipeline');
  const wav = await ensureWav(projectId, sourcePath, probe);
  const script = path.join(config.root, 'scripts', 'transcribe.py');
  const language = pipeline.whisper_language && pipeline.whisper_language !== 'auto' ? pipeline.whisper_language : '';
  const args = [
    script, wav,
    '--model', pipeline.whisper_model,
    '--language', language,
    '--word-timestamps', pipeline.word_timestamps ? '1' : '0',
  ];

  const result = await new Promise<{ segments: TranscriptSegment[]; language: string; duration: number }>((resolve, reject) => {
    const child = spawn(config.python, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    // Faster-whisper beam search can hang on noisy sections; without a cap the
    // child would burn 100% CPU forever. Ceiling: 4x audio length, min 15 min.
    const timeoutMs = Math.max(15 * 60_000, (probe.duration || 600) * 4 * 1000);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`transcription timed out after ${Math.round(timeoutMs / 60000)} min (whisper stuck)`));
    }, timeoutMs);
    let buf = '';
    let stderrBuf = '';
    const parseLine = (line: string) => {
      let obj: any;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.type === 'progress') {
        if (obj.duration > 0) onProgress(Math.min(95, (obj.done / obj.duration) * 100));
      } else if (obj.type === 'done') {
        clearTimeout(timer);
        resolve({ segments: obj.segments ?? [], language: obj.language || 'unknown', duration: obj.duration ?? probe.duration });
      }
    };
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) parseLine(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderrBuf += d.toString('utf8')));
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`transcribe sidecar failed to start: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`transcribe exited ${code}: ${stderrBuf.slice(-500)}`));
    });
  });

  const data: TranscriptData = {
    model: pipeline.whisper_model,
    language: result.language,
    duration: result.duration,
    segments: result.segments.filter((s) => s.text.length > 0),
    text: result.segments.map((s) => s.text).join(' '),
  };
  persistTranscript(projectId, data);
  onProgress(100);
  logger.info('TRANSCRIPTION', `project ${projectId}: ${data.segments.length} segments, language=${data.language}`);
  return data;
}

function persistTranscript(projectId: string, data: TranscriptData) {
  q.run('DELETE FROM transcripts WHERE project_id = ?', projectId);
  q.run(
    'INSERT INTO transcripts (project_id, model, language, segments, text, duration) VALUES (?,?,?,?,?,?)',
    projectId, data.model, data.language, JSON.stringify(data.segments), data.text, data.duration
  );
}

export function loadTranscript(projectId: string): TranscriptData | null {
  const row = q.get<{ model: string; language: string; segments: string; text: string; duration: number | null }>(
    'SELECT model, language, segments, text, duration FROM transcripts WHERE project_id = ? ORDER BY id DESC LIMIT 1',
    projectId
  );
  if (!row) return null;
  return {
    model: row.model,
    language: row.language,
    duration: row.duration ?? 0,
    segments: JSON.parse(row.segments || '[]'),
    text: row.text,
  };
}

/** Format segments as "[i] [start-end]s: text" lines for AI prompts, with optional window + token budget. */
export function formatTranscriptForPrompt(
  segments: TranscriptSegment[],
  opts: { start?: number; end?: number; maxChars?: number } = {}
): string {
  const pad = 3; // segment margin
  const idxOf = new Map(segments.map((s, i) => [s, i]));
  let lines: { i: number; s: TranscriptSegment }[] = segments.map((s, i) => ({ i, s }));
  if (opts.start !== undefined || opts.end !== undefined) {
    const a = opts.start ?? 0;
    const b = opts.end ?? Infinity;
    lines = lines.filter(({ s }) => s.end >= a - 1 && s.start <= b + 1);
  }
  const out: string[] = [];
  let chars = 0;
  const budget = opts.maxChars ?? 42000;
  for (const { s } of lines) {
    const i = idxOf.get(s) ?? 0;
    const line = `[${i}] [${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`;
    if (chars + line.length > budget && out.length > 0) break;
    out.push(line);
    chars += line.length + 1;
  }
  return out.join('\n');
}
