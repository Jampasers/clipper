import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { config } from '../config.js';

const activeChildren = new Map<string, ChildProcess>();

/** Kill the ffmpeg process registered for a job (cancellation). */
export function killJob(jobId: string): boolean {
  const child = activeChildren.get(jobId);
  if (!child) return false;
  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
  return true;
}

export interface MediaProbe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
  format: string;
  bitrate: number;
  size: number;
  streams: {
    video: { index: number; codec: string; width: number; height: number; fps: number }[];
    audio: { index: number; codec: string; sample_rate: number }[];
  };
}

export function runCmd(
  cmd: string,
  args: string[],
  opts: { input?: string; onStderr?: (line: string) => void; onStdout?: (line: string) => void; env?: NodeJS.ProcessEnv; jobId?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env });
    if (opts.jobId) activeChildren.set(opts.jobId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdout) {
        for (const line of s.split(/\r?\n|\r/)) if (line.trim()) opts.onStdout(line);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) {
        for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onStderr(line);
      }
    });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
    child.on('error', (err) => {
      if (opts.jobId) activeChildren.delete(opts.jobId);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      if (opts.jobId) activeChildren.delete(opts.jobId);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Parse common ffmpeg progress: "time=00:01:23.45" */
export function parseProgressTime(line: string): number | null {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

export async function probeVideo(file: string): Promise<MediaProbe> {
  const { code, stdout, stderr } = await runCmd(config.ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(0, 500)}`);
  const raw = JSON.parse(stdout);
  const v = (raw.streams ?? []).find((s: any) => s.codec_type === 'video');
  const a = (raw.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const fps = v ? parseFps(v.avg_frame_rate || v.r_frame_rate || '30/1') : 0;
  return {
    duration: parseFloat(raw.format?.duration || v?.duration || '0'),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps,
    vcodec: v?.codec_name || '',
    acodec: a?.codec_name ?? null,
    hasAudio: !!a,
    hasVideo: !!v,
    format: raw.format?.format_name || '',
    bitrate: parseInt(raw.format?.bit_rate || '0', 10),
    size: parseInt(raw.format?.size || '0', 10),
    streams: {
      video: (raw.streams ?? [])
        .filter((s: any) => s.codec_type === 'video')
        .map((s: any) => ({ index: s.index, codec: s.codec_name, width: s.width, height: s.height, fps: parseFps(s.avg_frame_rate || '30/1') })),
      audio: (raw.streams ?? [])
        .filter((s: any) => s.codec_type === 'audio')
        .map((s: any) => ({ index: s.index, codec: s.codec_name, sample_rate: s.sample_rate })),
    },
  };
}

export function parseFps(rate: string): number {
  const [a, b] = rate.split('/').map(Number);
  if (!a || !b || b === 0) return 0;
  const f = a / b;
  return Math.round(f * 100) / 100;
}
