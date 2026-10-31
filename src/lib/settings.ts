import { q, J } from './sqlite.js';
import { config, ROOT } from '../config.js';

/**
 * Runtime settings live in the DB (editable from the dashboard).
 * Env vars are used only for bootstrap/infrastructure values.
 */

export interface AISettings {
  base_url: string;
  api_key: string;
  default_model: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  fallback_model: string;
  request_retries: number;
  /** task -> model routing */
  routing: Record<string, string>;
}

export interface ClippingSettings {
  min_clip_duration: number;
  max_clip_duration: number;
  target_clip_duration: number;
  top_clips: number;
  overlap_threshold: number; // 0..1 fraction of overlap considered duplicate
  pad_before: number;
  pad_after: number;
  max_candidates: number;
}

export interface ScoreWeights {
  hook: number;
  context: number;
  standalone: number;
  emotion: number;
  entertainment: number;
  payoff: number;
  curiosity: number;
  shareability: number;
  length: number;
}

export interface SubtitlePreset {
  font: string;
  font_size: number;
  position: 'bottom' | 'middle' | 'top';
  margin_v: number;
  max_chars_per_line: number;
  max_words_per_line: number;
  max_lines: number;
  primary_color: string;
  outline_color: string;
  outline_width: number;
  bold: boolean;
  uppercase: boolean;
  karaoke: boolean;
  karaoke_color: string;
  animation: 'none' | 'fade' | 'typewriter';
}

export interface SubtitleSettings {
  enabled: boolean;
  preset: string;
  /** 'remotion' = animated caption overlay; 'ass' = legacy ffmpeg burn-in */
  engine: 'remotion' | 'ass';
  presets: Record<string, SubtitlePreset>;
  emphasis: {
    enabled: boolean;
    color: string;
    scale_percent: number;
    bold: boolean;
  };
}

export interface ReframeSettings {
  aspect: '9:16' | '1:1' | '16:9';
  face_tracking: boolean;
  sample_interval: number;
  smoothing_window: number;
  max_speed: number;
  deadzone: number;
}

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string;
  crf: number;
  bitrate: string;
  audio_bitrate: string;
  preset: string;
  pixel_format: string;
  container: string;
  preview_width: number;
  preview_height: number;
  preview_crf: number;
}

export interface TelegramSettings {
  enabled: boolean;
  send_progress: boolean;
}

export interface PipelineSettings {
  whisper_model: string;
  whisper_language: string;
  word_timestamps: boolean;
}

export interface WatermarkSettings {
  /** Watermarks render by default; a render job can override this per job. */
  enabled: boolean;
  default_position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'custom';
  default_width_percent: number;
  default_opacity: number;
  default_margin: number;
}

export interface HookSettings {
  enabled: boolean;
  /** Target hook duration in seconds (actual may differ to keep word boundaries natural). */
  duration: number;
  min_duration: number;
  max_duration: number;
  allow_fallback: boolean;
}

export interface MusicSettings {
  enabled: boolean;
  /** 'ai' | 'none' | <music asset id> */
  selection: string;
  voice_ducking: boolean;
  /** Extra offset applied on top of the normalized music loudness (dB). */
  volume_db: number;
  /** Extra attenuation while dialogue is active (dB). */
  duck_db: number;
  fade_in: number;
  fade_out: number;
  voice_target_lufs: number;
  /** BGM loudness when nobody is talking (LUFS). */
  music_target_lufs: number;
  /** True-peak ceiling for the final mix (dBTP, negative). */
  true_peak_db: number;
}

export interface CreativeSettings {
  /** 'basic' = classic behavior, 'adaptive' = Creative Director EDL (zoom/grade/graphics) */
  mode: 'basic' | 'adaptive';
  /** run the post-render quality review + bounded EDL repair / re-render */
  quality_review: boolean;
  /** render AI graphics (titles, lower thirds, stat cards, callouts, progress bar) */
  graphics: boolean;
}

export interface AllSettings {
  ai: AISettings;
  clipping: ClippingSettings;
  scoring: ScoreWeights;
  subtitles: SubtitleSettings;
  reframe: ReframeSettings;
  render: RenderSettings;
  telegram: TelegramSettings;
  pipeline: PipelineSettings;
  watermark: WatermarkSettings;
  hook: HookSettings;
  music: MusicSettings;
  creative: CreativeSettings;
}

export const DEFAULT_SETTINGS: AllSettings = {
  ai: {
    base_url: config.ai.baseUrl,
    api_key: config.ai.apiKey,
    default_model: config.ai.defaultModel,
    temperature: 0.3,
    max_tokens: 4096,
    timeout_ms: 120000,
    fallback_model: '',
    request_retries: 2,
    routing: {
      highlight_detection: config.ai.defaultModel,
      clip_scoring: config.ai.defaultModel,
      clip_boundary: config.ai.defaultModel,
      title_generation: config.ai.defaultModel,
      subtitle_analysis: config.ai.defaultModel,
      content_analysis: config.ai.defaultModel,
      hook_generation: config.ai.defaultModel,
      subtitle_plan: config.ai.defaultModel,
      music_selection: config.ai.defaultModel,
      creative_direction: config.ai.defaultModel,
    },
  },
  clipping: {
    min_clip_duration: 20,
    max_clip_duration: 90,
    target_clip_duration: 45,
    top_clips: 5,
    overlap_threshold: 0.5,
    pad_before: 0.4,
    pad_after: 0.6,
    max_candidates: 15,
  },
  scoring: {
    hook: 20,
    context: 6,
    standalone: 14,
    emotion: 15,
    entertainment: 8,
    payoff: 20,
    curiosity: 7,
    shareability: 5,
    length: 5,
  },
  subtitles: {
    enabled: true,
    preset: 'bold',
    engine: 'remotion',
    emphasis: { enabled: true, color: '#FFD400', scale_percent: 112, bold: true },
    presets: {
      classic: {
        font: 'Arial', font_size: 15, position: 'bottom', margin_v: 60, max_chars_per_line: 42,
        max_words_per_line: 9, max_lines: 2, primary_color: '#FFFFFF', outline_color: '#000000',
        outline_width: 2, bold: false, uppercase: false, karaoke: false, karaoke_color: '#FFD400', animation: 'none',
      },
      bold: {
        font: 'Arial Black', font_size: 17, position: 'bottom', margin_v: 70, max_chars_per_line: 32,
        max_words_per_line: 6, max_lines: 2, primary_color: '#FFFFFF', outline_color: '#000000',
        outline_width: 3, bold: true, uppercase: false, karaoke: false, karaoke_color: '#FFD400', animation: 'none',
      },
      minimal: {
        font: 'Helvetica', font_size: 13, position: 'bottom', margin_v: 50, max_chars_per_line: 48,
        max_words_per_line: 10, max_lines: 2, primary_color: '#FFFFFF', outline_color: '#000000',
        outline_width: 1, bold: false, uppercase: false, karaoke: false, karaoke_color: '#FFD400', animation: 'fade',
      },
      karaoke: {
        font: 'Arial Black', font_size: 17, position: 'bottom', margin_v: 70, max_chars_per_line: 30,
        max_words_per_line: 5, max_lines: 2, primary_color: '#FFFFFF', outline_color: '#000000',
        outline_width: 3, bold: true, uppercase: false, karaoke: true, karaoke_color: '#FF3D00', animation: 'none',
      },
      podcast: {
        font: 'Verdana', font_size: 14, position: 'middle', margin_v: 180, max_chars_per_line: 40,
        max_words_per_line: 8, max_lines: 3, primary_color: '#FFFFFF', outline_color: '#101010',
        outline_width: 2, bold: false, uppercase: false, karaoke: false, karaoke_color: '#8AB4FF', animation: 'fade',
      },
    },
  },
  reframe: {
    aspect: '9:16',
    face_tracking: true,
    sample_interval: 0.7,
    smoothing_window: 4,
    max_speed: 160, // px per second of pan, at output scale
    deadzone: 40, // px, don't move camera for small shifts
  },
  render: {
    width: 1080,
    height: 1920,
    fps: 30,
    vcodec: 'libx264',
    acodec: 'aac',
    crf: 20,
    bitrate: '',
    audio_bitrate: '192k',
    preset: 'medium',
    pixel_format: 'yuv420p',
    container: 'mp4',
    preview_width: 540,
    preview_height: 960,
    preview_crf: 30,
  },
  telegram: { enabled: true, send_progress: true },
  pipeline: {
    whisper_model: config.whisper.model,
    whisper_language: 'auto',
    word_timestamps: true,
  },
  watermark: {
    enabled: true,
    default_position: 'bottom-right',
    default_width_percent: 18,
    default_opacity: 0.85,
    default_margin: 36,
  },
  hook: {
    enabled: true,
    duration: 7,
    min_duration: 3,
    max_duration: 12,
    allow_fallback: true,
  },
  music: {
    enabled: true,
    selection: 'ai',
    voice_ducking: true,
    volume_db: 0,
    duck_db: 7,
    fade_in: 0.8,
    fade_out: 1.5,
    voice_target_lufs: -16,
    music_target_lufs: -17,
    true_peak_db: -1,
  },
  creative: {
    mode: 'adaptive',
    quality_review: true,
    graphics: true,
  },
};

export type SettingsGroup = keyof AllSettings;

export function getSettings<K extends SettingsGroup>(key: K): AllSettings[K] {
  const row = q.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  const stored = J.read(row?.value) ?? {};
  const base = DEFAULT_SETTINGS[key] as unknown as Record<string, unknown>;
  return deepMerge({ ...base }, stored) as unknown as AllSettings[K];
}

export function getAllSettings(): AllSettings {
  return {
    ai: getSettings('ai'),
    clipping: getSettings('clipping'),
    scoring: getSettings('scoring'),
    subtitles: getSettings('subtitles'),
    reframe: getSettings('reframe'),
    render: getSettings('render'),
    telegram: getSettings('telegram'),
    pipeline: getSettings('pipeline'),
    watermark: getSettings('watermark'),
    hook: getSettings('hook'),
    music: getSettings('music'),
    creative: getSettings('creative'),
  };
}

export function setSettings(key: SettingsGroup, patch: Record<string, unknown>): AllSettings[SettingsGroup] {
  const merged = deepMerge({ ...(getSettings(key) as unknown as Record<string, unknown>) }, patch);
  q.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    JSON.stringify(merged)
  );
  return getSettings(key);
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return '****' + key.slice(-4);
}

export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge({ ...(b as Record<string, unknown>) }, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Directory helpers that respect storage settings in DB (env is fallback). */
export function storageDirs() {
  return { ...config.dirs, projectDir: config.dirs.project };
}

export { ROOT, config };
