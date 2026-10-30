import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runCmd } from './ffmpeg.js';

export interface YtMeta {
  title: string | null;
  duration: number | null;
}

export interface YtDlpResult {
  file: string;
}

const BASE_ARGS = ['-m', 'yt_dlp', '--no-playlist'];

function ytdlpError(exitCode: number, output: string): Error {
  // Last non-empty meaningful line from yt-dlp (ERROR:/WARNING: lines)
  const lines = output.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('['));
  const detail = lines.length ? lines[lines.length - 1] : output.trim().split('\n').pop() || 'no output';
  return new Error(`yt-dlp failed (exit ${exitCode}): ${detail.slice(0, 300)}`);
}

/** Quick metadata fetch (no download). Fails fast for unavailable/private videos. */
export async function ytdlpMeta(url: string): Promise<YtMeta> {
  const { code, stdout, stderr } = await runCmd(config.python, [...BASE_ARGS, '--dump-json', '--skip-download', '--', url]);
  if (code !== 0 || !stdout.trim()) throw ytdlpError(code, stderr || stdout);
  try {
    const j = JSON.parse(stdout.trim().split('\n')[0]);
    return {
      title: typeof j.title === 'string' ? j.title : null,
      duration: typeof j.duration === 'number' ? j.duration : null,
    };
  } catch {
    return { title: null, duration: null };
  }
}

/**
 * Download a video from a URL (YouTube, etc.) via yt-dlp into destDir as source.<ext>.
 * yt-dlp is invoked as `python -m yt_dlp` (installed via requirements.txt);
 * set YTDLP_PATH to use a standalone binary instead.
 */
export async function ytdlpDownload(url: string, destDir: string, onProgress?: (line: string) => void): Promise<YtDlpResult> {
  fs.mkdirSync(destDir, { recursive: true });
  const outTpl = path.join(destDir, 'source.%(ext)s');
  const args = [
    ...BASE_ARGS,
    '--newline',
    '-f', `bv*[height<=${config.ytdlpMaxHeight}]+ba/b[height<=${config.ytdlpMaxHeight}]/b`,
    '--merge-output-format', 'mp4',
    '-o', outTpl,
    '--', url,
  ];
  let tail = '';
  const { code } = await runCmd(config.python, args, {
    // yt-dlp prints [download] progress lines on stdout; errors/warnings on stderr.
    onStdout: (line) => onProgress?.(line),
    onStderr: (line) => {
      tail = (tail + '\n' + line).slice(-4000);
      onProgress?.(line);
    },
  });
  // yt-dlp logs to stderr; success = exit 0 + an existing source.*
  const file = fs.readdirSync(destDir).find((f) => /^source\.(mp4|mkv|webm|mov|avi)$/i.test(f));
  if (code !== 0 || !file) throw ytdlpError(code, tail);
  return { file: path.join(destDir, file) };
}
