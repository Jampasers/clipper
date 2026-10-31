import { z } from 'zod';
import crypto from 'node:crypto';
import { q, J } from '../lib/sqlite.js';
import { getSettings, deepMerge } from '../lib/settings.js';
import { logger } from '../lib/log.js';

/**
 * Per-render customization. Every render job carries a resolved snapshot of
 * these options (stored in the job payload + render_snapshots), so global
 * settings changed mid-queue never leak into an already-queued render.
 */

export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'custom';
export type SubtitleStyleName = 'ai' | 'bold' | 'karaoke' | 'kinetic';
export const SUBTITLE_STYLES: SubtitleStyleName[] = ['ai', 'bold', 'karaoke', 'kinetic'];
export const WATERMARK_POSITIONS: WatermarkPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'custom'];

export interface WatermarkOverride {
  position?: WatermarkPosition;
  x?: number;
  y?: number;
  widthPercent?: number;
  opacity?: number;
  margin?: number;
}

export interface RenderOptions {
  aspect?: '9:16' | '1:1' | '16:9';
  watermark: {
    enabled: boolean;
    /** specific watermark ids; empty = all enabled watermarks */
    ids: string[];
    overrides?: Record<string, WatermarkOverride>;
  };
  hook: {
    enabled: boolean;
    duration: number;
    allowFallback: boolean;
  };
  backgroundMusic: {
    enabled: boolean;
    /** 'ai' | 'none' | <music asset id> */
    selection: string;
    voiceDucking: boolean;
    volumeDb: number;
    duckDb: number;
    fadeIn: number;
    fadeOut: number;
  };
  subtitles: {
    enabled: boolean;
    style: SubtitleStyleName;
    aiHighlight: boolean;
    animations: boolean;
    preset?: string | null;
  };
  creative: {
    /** 'basic' keeps the classic render; 'adaptive' uses the Creative Director EDL */
    mode: 'basic' | 'adaptive';
    qualityReview: boolean;
  };
}

const watermarkOverrideSchema = z.object({
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'custom']).optional(),
  x: z.number().min(0).max(100000).optional(),
  y: z.number().min(0).max(100000).optional(),
  widthPercent: z.number().min(1).max(100).optional(),
  opacity: z.number().min(0).max(1).optional(),
  margin: z.number().min(0).max(500).optional(),
});

export const renderOptionsSchema = z
  .object({
    aspect: z.enum(['9:16', '1:1', '16:9']).optional(),
    watermark: z.object({
      enabled: z.boolean(),
      ids: z.array(z.string().min(1).max(40)).max(10),
      overrides: z.record(z.string(), watermarkOverrideSchema).optional(),
    }),
    hook: z.object({
      enabled: z.boolean(),
      duration: z.number().min(3).max(15),
      allowFallback: z.boolean(),
    }),
    backgroundMusic: z.object({
      enabled: z.boolean(),
      selection: z.string().min(1).max(60),
      voiceDucking: z.boolean(),
      volumeDb: z.number().min(-40).max(12),
      duckDb: z.number().min(0).max(30),
      fadeIn: z.number().min(0).max(10),
      fadeOut: z.number().min(0).max(10),
    }),
    subtitles: z.object({
      enabled: z.boolean(),
      style: z.enum(['ai', 'bold', 'karaoke', 'kinetic']),
      aiHighlight: z.boolean(),
      animations: z.boolean(),
      preset: z.string().max(40).nullable().optional(),
    }),
    creative: z.object({
      mode: z.enum(['basic', 'adaptive']),
      qualityReview: z.boolean(),
    }),
  })
  .strict();

/** The spec default block, materialized from global settings. */
export function defaultRenderOptions(): RenderOptions {
  const wm = getSettings('watermark');
  const hook = getSettings('hook');
  const music = getSettings('music');
  const sub = getSettings('subtitles');
  const creative = getSettings('creative');
  return {
    watermark: { enabled: wm.enabled, ids: [] },
    hook: { enabled: hook.enabled, duration: hook.duration, allowFallback: hook.allow_fallback },
    backgroundMusic: {
      enabled: music.enabled,
      selection: music.selection || 'ai',
      voiceDucking: music.voice_ducking,
      volumeDb: music.volume_db,
      duckDb: music.duck_db,
      fadeIn: music.fade_in,
      fadeOut: music.fade_out,
    },
    subtitles: { enabled: sub.enabled, style: 'ai', aiHighlight: true, animations: true, preset: null },
    creative: { mode: creative.mode, qualityReview: creative.quality_review },
  };
}

export interface RenderPresetDef {
  name: string;
  label: string;
  description: string;
  builtin: boolean;
  options: DeepPartial<RenderOptions>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Built-in presets (spec section 9). Custom is just "edit the defaults in the UI". */
export const BUILTIN_RENDER_PRESETS: Record<string, RenderPresetDef> = {
  default_ai: {
    name: 'default_ai',
    label: 'Default AI',
    description: 'Everything on: AI hook, AI music with ducking, AI dynamic subtitles, watermarks.',
    builtin: true,
    options: {},
  },
  clean: {
    name: 'clean',
    label: 'Clean',
    description: 'Classic edit: watermark on, no hook, no music, calm subtitles without animations.',
    builtin: true,
    options: {
      hook: { enabled: false },
      backgroundMusic: { enabled: false },
      subtitles: { enabled: true, style: 'bold', aiHighlight: false, animations: false },
      creative: { mode: 'basic' },
    },
  },
  dynamic: {
    name: 'dynamic',
    label: 'Dynamic',
    description: 'Hook + music + kinetic typography with animations.',
    builtin: true,
    options: {
      hook: { enabled: true },
      backgroundMusic: { enabled: true },
      subtitles: { enabled: true, style: 'kinetic', aiHighlight: true, animations: true },
    },
  },
  minimal: {
    name: 'minimal',
    label: 'Minimal',
    description: 'No watermark, no hook, no music, plain AI subtitles without highlights, classic render.',
    builtin: true,
    options: {
      watermark: { enabled: false },
      hook: { enabled: false },
      backgroundMusic: { enabled: false },
      subtitles: { enabled: true, style: 'ai', aiHighlight: false, animations: false },
      creative: { mode: 'basic' },
    },
  },
};

export function listRenderPresets(): RenderPresetDef[] {
  const custom = q
    .all<{ name: string; data: string }>('SELECT name, data FROM render_presets ORDER BY name')
    .map((r): RenderPresetDef => ({
      name: r.name,
      label: r.name,
      description: 'Custom preset',
      builtin: false,
      options: (J.read<DeepPartial<RenderOptions>>(r.data) ?? {}),
    }));
  return [...Object.values(BUILTIN_RENDER_PRESETS), ...custom];
}

export function saveRenderPreset(name: string, options: unknown): RenderPresetDef {
  const clean = name.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  if (!clean) throw badRequest('preset name required');
  if (BUILTIN_RENDER_PRESETS[clean]) throw badRequest(`"${clean}" is a built-in preset name`);
  const parsed = renderOptionsSchema.safeParse(deepMerge(defaultRenderOptions() as unknown as Record<string, unknown>, (options ?? {}) as Record<string, unknown>));
  if (!parsed.success) throw badRequest(`invalid preset options: ${zodMessage(parsed.error)}`);
  q.run(
    `INSERT INTO render_presets (name, data) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
    clean,
    JSON.stringify(parsed.data)
  );
  return { name: clean, label: clean, description: 'Custom preset', builtin: false, options: parsed.data };
}

export function deleteRenderPreset(name: string): boolean {
  if (BUILTIN_RENDER_PRESETS[name]) return false;
  const res = q.run('DELETE FROM render_presets WHERE name = ?', name);
  return res.changes > 0;
}

function zodMessage(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');
}

function badRequest(message: string): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = 400;
  return e;
}

/**
 * Resolve the effective options for a render job: defaults -> preset -> request
 * overrides, then fully validate. Throws a 400-tagged error on invalid input.
 */
export function resolveRenderOptions(input: unknown, presetName?: string | null): { options: RenderOptions; preset: string | null } {
  let base = defaultRenderOptions() as unknown as Record<string, unknown>;
  let preset: string | null = null;
  if (presetName) {
    const def = BUILTIN_RENDER_PRESETS[presetName] ?? listRenderPresets().find((p) => p.name === presetName);
    if (!def) throw badRequest(`unknown render preset "${presetName}"`);
    base = deepMerge(base, def.options as unknown as Record<string, unknown>);
    preset = def.name;
  }
  const merged = deepMerge(base, (input ?? {}) as Record<string, unknown>);
  const parsed = renderOptionsSchema.safeParse(merged);
  if (!parsed.success) throw badRequest(`invalid render options: ${zodMessage(parsed.error)}`);
  return { options: parsed.data as RenderOptions, preset };
}

/** Stable hash of the options that influence the AI creative plan (hook/music/subtitles). */
export function planOptionsHash(options: RenderOptions, extra: Record<string, unknown> = {}): string {
  const relevant = {
    v: 2,
    aspect: options.aspect ?? null,
    hook: { enabled: options.hook.enabled, duration: options.hook.duration, allowFallback: options.hook.allowFallback },
    music: { enabled: options.backgroundMusic.enabled, selection: options.backgroundMusic.selection },
    subtitles: {
      enabled: options.subtitles.enabled,
      style: options.subtitles.style,
      aiHighlight: options.subtitles.aiHighlight,
      preset: options.subtitles.preset ?? null,
    },
    creative: { mode: options.creative?.mode ?? 'basic' },
    extra,
  };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 20);
}

export function saveRenderSnapshot(jobId: string, clipId: string, options: RenderOptions): void {
  q.run('INSERT INTO render_snapshots (job_id, clip_id, options) VALUES (?,?,?)', jobId, clipId, JSON.stringify(options));
  logger.debug('RENDER', `snapshot stored for job ${jobId} (clip ${clipId})`);
}

export function getRenderSnapshots(clipId: string, limit = 20) {
  return q
    .all<{ id: number; job_id: string; options: string; created_at: string }>(
      'SELECT id, job_id, options, created_at FROM render_snapshots WHERE clip_id = ? ORDER BY id DESC LIMIT ?',
      clipId,
      limit
    )
    .map((r) => ({ ...r, options: J.read<RenderOptions>(r.options) ?? null }));
}
