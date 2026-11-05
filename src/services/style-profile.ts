import { z } from 'zod';

/**
 * Structured, versioned style profile for a reference video.
 *
 * Design rules:
 *  - Every observable carries its own confidence + evidence (frame/time refs).
 *  - Qualitative labels may be "unknown" when frames do not show enough.
 *  - Numeric measurements (brightness, contrast, saturation, cut rate, audio
 *    dynamics) are NEVER produced by the model — they are computed locally with
 *    FFmpeg and merged in here.
 *  - Validation happens before persistence; invalid items degrade to "unknown".
 */

export const STYLE_PROFILE_VERSION = 1;

export const TIERS = ['very_low', 'low', 'medium', 'medium_high', 'high', 'very_high'] as const;
export type Tier = (typeof TIERS)[number];

export const COLOR_GRADES = ['warm', 'cool', 'neutral', 'high_contrast_warm', 'high_contrast_cool', 'desaturated', 'vivid', 'cinematic'] as const;
export const CAMERA_MOVEMENTS = ['static', 'pan', 'tilt', 'handheld', 'zoom', 'mixed'] as const;
export const SUBJECT_PRIORITIES = ['speaker', 'subject', 'product', 'group', 'mixed'] as const;
export const SUBTITLE_STYLES = ['none', 'static', 'bold_uppercase', 'karaoke', 'kinetic', 'word_by_word'] as const;
export const HIGHLIGHT_MODES = ['none', 'keyword', 'semantic', 'karaoke'] as const;
export const TRANSITION_KINDS = ['cut', 'fade', 'zoom', 'slide', 'whip', 'glitch', 'other'] as const;
export const OVERLAY_POSITIONS = ['top', 'center', 'bottom', 'mixed'] as const;

const evidence = z.array(z.string().min(1).max(240)).max(8).default([]);

const obsBase = { confidence: z.number().min(0).max(1).default(0), evidence };

export const OBS_TIER = z.object({ value: z.union([z.enum(TIERS), z.literal('unknown')]).default('unknown'), ...obsBase }).strict();
export const OBS_UNIT = z.object({ value: z.number().min(0).max(1).nullable().default(null), ...obsBase }).strict();
export const OBS_BOOL = z.object({ value: z.boolean().nullable().default(null), ...obsBase }).strict();
export const OBS_TEXT = z.object({ value: z.string().min(1).max(160).nullable().default(null), ...obsBase }).strict();
export const OBS_ENUM = <T extends readonly [string, ...string[]]>(values: T) =>
  z.object({ value: z.union([z.enum(values), z.literal('unknown')]).default('unknown'), ...obsBase }).strict();
export const OBS_NUM = (min: number, max: number) =>
  z.object({ value: z.number().min(min).max(max).nullable().default(null), ...obsBase }).strict();

export type TierObs = z.infer<typeof OBS_TIER>;
export type UnitObs = z.infer<typeof OBS_UNIT>;
export type EnumObs<T extends readonly string[]> = { value: T[number] | 'unknown'; confidence: number; evidence: string[] };

export const STYLE_PROFILE_SCHEMA = z
  .object({
    profileVersion: z.literal(STYLE_PROFILE_VERSION),
    category: z.array(z.string().min(1).max(40)).max(8).default([]),
    tags: z.array(z.string().min(1).max(40)).max(12).default([]),
    visualStyle: z
      .object({
        colorGrade: OBS_ENUM(COLOR_GRADES),
        brightness: OBS_UNIT,
        contrast: OBS_UNIT,
        saturation: OBS_UNIT,
        typography: z.object({ value: z.string().max(160).nullable().default(null), ...obsBase }).strict(),
        motionGraphics: OBS_TIER,
        overlayPosition: OBS_ENUM(OVERLAY_POSITIONS),
        graphicDensity: OBS_TIER,
      })
      .strict(),
    camera: z
      .object({
        movement: OBS_ENUM(CAMERA_MOVEMENTS),
        zoomFrequency: OBS_TIER,
        zoomIntensity: OBS_UNIT,
        framingVariation: OBS_TIER,
        subjectPriority: OBS_ENUM(SUBJECT_PRIORITIES),
      })
      .strict(),
    pacing: z
      .object({
        averageShotDuration: OBS_NUM(0.2, 120),
        cutCpm: OBS_NUM(0, 240),
        dynamicPacing: OBS_BOOL,
      })
      .strict(),
    subtitles: z
      .object({
        style: OBS_ENUM(SUBTITLE_STYLES),
        maxWordsPerGroup: OBS_NUM(1, 12),
        highlightMode: OBS_ENUM(HIGHLIGHT_MODES),
      })
      .strict(),
    transitions: z
      .object({
        preferred: z
          .object({ value: z.array(z.enum(TRANSITION_KINDS)).max(4).default([]), ...obsBase })
          .strict(),
        intensity: OBS_TIER,
      })
      .strict(),
    audio: z
      .object({
        musicEnergy: OBS_TIER,
        sfxDensity: OBS_TIER,
        loudnessRange: OBS_NUM(0, 40),
        integratedLoudness: OBS_NUM(-70, 0),
      })
      .strict(),
    editing: z
      .object({
        hookStructure: OBS_TEXT,
        introPattern: OBS_TEXT,
        outroPattern: OBS_TEXT,
      })
      .strict(),
    confidence: z.number().min(0).max(1).default(0),
    model: z.string().max(160).nullable().default(null),
    promptVersion: z.number().int().default(1),
    generatedAt: z.string().min(1),
  })
  .strict();

export type StyleProfile = z.infer<typeof STYLE_PROFILE_SCHEMA>;

/** Deterministic measurements computed locally with FFmpeg (never by a model). */
export interface ReferenceMeasurements {
  duration: number;
  width: number;
  height: number;
  fps: number;
  sampledFrames: number;
  /** mean per-pixel brightness 0..1 */
  brightness: number | null;
  /** mean (YMAX-YMIN) local contrast 0..1 */
  contrast: number | null;
  /** mean saturation 0..1 (SATAVG/128, clamped) */
  saturation: number | null;
  cutCount: number;
  cutCpm: number | null;
  averageShotDuration: number | null;
  /** mean inter-frame difference 0..1 (motion proxy) */
  motionIntensity: number | null;
  /** bottom-band inter-frame activity 0..1 (subtitle/graphics proxy) */
  subtitleActivity: number | null;
  loudnessRange: number | null;
  integratedLoudness: number | null;
  truePeak: number | null;
  /** silence spans / duration 0..1 */
  silenceRatio: number | null;
  cuts: number[];
}

export const EMPTY_MEASUREMENTS: ReferenceMeasurements = {
  duration: 0,
  width: 0,
  height: 0,
  fps: 0,
  sampledFrames: 0,
  brightness: null,
  contrast: null,
  saturation: null,
  cutCount: 0,
  cutCpm: null,
  averageShotDuration: null,
  motionIntensity: null,
  subtitleActivity: null,
  loudnessRange: null,
  integratedLoudness: null,
  truePeak: null,
  silenceRatio: null,
  cuts: [],
};

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function tierFromCutCpm(cpm: number): Tier {
  if (cpm < 1) return 'very_low';
  if (cpm < 3) return 'low';
  if (cpm < 6) return 'medium';
  if (cpm < 10) return 'medium_high';
  if (cpm < 18) return 'high';
  return 'very_high';
}

export function tierFromLoudnessRange(lra: number): Tier {
  if (lra < 2.5) return 'very_low';
  if (lra < 5) return 'low';
  if (lra < 8) return 'medium';
  if (lra < 11) return 'medium_high';
  if (lra < 15) return 'high';
  return 'very_high';
}

const MEASUREMENT_EVIDENCE = 'ffmpeg signalstats (deterministic local measurement)';

/**
 * Sanitize the model's qualitative observations. Unknown / out-of-range values
 * become "unknown" instead of rejecting the profile; numbers the model may not
 * provide are ignored entirely (they are merged from measurements below).
 */
export interface AiObservations {
  categories?: unknown;
  tags?: unknown;
  visual?: {
    colorGrade?: unknown;
    typography?: unknown;
    motionGraphics?: unknown;
    overlayPosition?: unknown;
    graphicDensity?: unknown;
  };
  camera?: { movement?: unknown; zoomFrequency?: unknown; framingVariation?: unknown; subjectPriority?: unknown };
  subtitles?: { style?: unknown; maxWordsPerGroup?: unknown; highlightMode?: unknown };
  transitions?: { preferred?: unknown; intensity?: unknown };
  audio?: { musicEnergy?: unknown; sfxDensity?: unknown };
  editing?: { hookStructure?: unknown; introPattern?: unknown; outroPattern?: unknown };
  evidence?: unknown;
  confidence?: unknown;
}

function enumOrUnknown<T extends readonly [string, ...string[]]>(values: T, v: unknown): T[number] | 'unknown' {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T[number]) : 'unknown';
}

function tierOrUnknown(v: unknown): Tier | 'unknown' {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v) ? (v as Tier) : 'unknown';
}

function cleanStringArray(v: unknown, max: number, maxLen = 40): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    if (!s || out.includes(s)) continue;
    out.push(s.slice(0, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 160);
  return s || null;
}

function evidenceFrom(ai: AiObservations, fallback: string): string[] {
  const list = cleanStringArray(ai.evidence, 6, 200);
  return list.length ? list : [fallback];
}

/**
 * Merge AI qualitative observations with local measurements into a validated
 * profile. Measurement values always win over model output for numeric fields.
 */
export function buildStyleProfile(input: {
  ai: AiObservations | null;
  measurements: ReferenceMeasurements;
  meta: { name: string; duration: number; width: number; height: number; fps: number };
  model: string | null;
  promptVersion?: number;
  sessionConfidence?: number;
}): StyleProfile {
  const ai = input.ai ?? {};
  const m = input.measurements;
  const ev = evidenceFrom(ai, 'model observation');
  const visionOk = !!input.ai;
  const c = (v: number) => round(clamp01(v));

  const aiConf = (base: number) => {
    const modelConf = typeof ai.confidence === 'number' && Number.isFinite(ai.confidence) ? clamp01(ai.confidence) : 0.6;
    return visionOk ? round(clamp01(base * modelConf + (1 - modelConf) * 0.35)) : 0;
  };

  const cutCpm = m.cutCpm;
  const measured = (v: number | null, digits = 3) => (v === null ? null : round(v, digits));
  // Clamp to the schema's OBS_NUM range so pathological measurements (e.g. a
  // 19s video misdetected as one 0.1s shot) degrade to the floor instead of
  // failing the whole profile parse.
  const num = (v: number | null, min: number, max: number, digits = 2) => (v === null ? null : round(Math.min(max, Math.max(min, v)), digits));

  const profile: StyleProfile = {
    profileVersion: STYLE_PROFILE_VERSION,
    category: cleanStringArray(ai.categories, 5),
    tags: cleanStringArray(ai.tags, 8),
    visualStyle: {
      colorGrade: {
        value: enumOrUnknown(COLOR_GRADES, ai.visual?.colorGrade),
        confidence: visionOk && ai.visual?.colorGrade ? aiConf(0.9) : 0,
        evidence: ev,
      },
      brightness: { value: measured(m.brightness), confidence: m.brightness === null ? 0 : 0.9, evidence: [MEASUREMENT_EVIDENCE] },
      contrast: { value: measured(m.contrast), confidence: m.contrast === null ? 0 : 0.85, evidence: [MEASUREMENT_EVIDENCE] },
      saturation: { value: measured(m.saturation), confidence: m.saturation === null ? 0 : 0.8, evidence: [MEASUREMENT_EVIDENCE] },
      typography: {
        value: cleanText(ai.visual?.typography),
        confidence: visionOk && cleanText(ai.visual?.typography) ? aiConf(0.8) : 0,
        evidence: ev,
      },
      motionGraphics: {
        value: tierOrUnknown(ai.visual?.motionGraphics),
        confidence: visionOk && ai.visual?.motionGraphics ? aiConf(0.8) : 0,
        evidence: ev,
      },
      overlayPosition: {
        value: enumOrUnknown(OVERLAY_POSITIONS, ai.visual?.overlayPosition),
        confidence: visionOk && ai.visual?.overlayPosition ? aiConf(0.7) : 0,
        evidence: ev,
      },
      graphicDensity: {
        value: tierOrUnknown(ai.visual?.graphicDensity),
        confidence: visionOk && ai.visual?.graphicDensity ? aiConf(0.75) : 0,
        evidence: ev,
      },
    },
    camera: {
      movement: {
        value: enumOrUnknown(CAMERA_MOVEMENTS, ai.camera?.movement),
        confidence: visionOk && ai.camera?.movement ? aiConf(0.7) : 0,
        evidence: ev,
      },
      zoomFrequency: {
        value: tierOrUnknown(ai.camera?.zoomFrequency),
        confidence: visionOk && ai.camera?.zoomFrequency ? aiConf(0.7) : 0,
        evidence: ev,
      },
      zoomIntensity: {
        value: m.motionIntensity === null ? null : c(Math.min(1, m.motionIntensity * 2.2)),
        confidence: m.motionIntensity === null ? 0 : 0.35,
        evidence: m.motionIntensity === null ? [] : ['motion proxy from ffmpeg tblend (not a true zoom measurement)'],
      },
      framingVariation: {
        value: tierOrUnknown(ai.camera?.framingVariation),
        confidence: visionOk && ai.camera?.framingVariation ? aiConf(0.75) : 0,
        evidence: ev,
      },
      subjectPriority: {
        value: enumOrUnknown(SUBJECT_PRIORITIES, ai.camera?.subjectPriority),
        confidence: visionOk && ai.camera?.subjectPriority ? aiConf(0.8) : 0,
        evidence: ev,
      },
    },
    pacing: {
      averageShotDuration: { value: num(m.averageShotDuration, 0.2, 120), confidence: m.averageShotDuration === null ? 0 : 0.8, evidence: [MEASUREMENT_EVIDENCE] },
      cutCpm: { value: num(cutCpm, 0, 240), confidence: cutCpm === null ? 0 : 0.85, evidence: [MEASUREMENT_EVIDENCE] },
      dynamicPacing: {
        value: cutCpm === null ? null : cutCpm >= 6,
        confidence: cutCpm === null ? 0 : 0.6,
        evidence: cutCpm === null ? [] : [`cut rate ${round(cutCpm, 1)}/min ${MEASUREMENT_EVIDENCE}`],
      },
    },
    subtitles: {
      style: {
        value: enumOrUnknown(SUBTITLE_STYLES, ai.subtitles?.style),
        confidence: visionOk && ai.subtitles?.style ? aiConf(0.85) : 0,
        evidence: ev,
      },
      maxWordsPerGroup: {
        value:
          typeof ai.subtitles?.maxWordsPerGroup === 'number' && Number.isFinite(ai.subtitles.maxWordsPerGroup)
            ? Math.min(12, Math.max(1, Math.round(ai.subtitles.maxWordsPerGroup)))
            : null,
        confidence: visionOk && typeof ai.subtitles?.maxWordsPerGroup === 'number' ? aiConf(0.8) : 0,
        evidence: ev,
      },
      highlightMode: {
        value: enumOrUnknown(HIGHLIGHT_MODES, ai.subtitles?.highlightMode),
        confidence: visionOk && ai.subtitles?.highlightMode ? aiConf(0.7) : 0,
        evidence: ev,
      },
    },
    transitions: {
      preferred: {
        value: Array.isArray(ai.transitions?.preferred)
          ? cleanStringArray(ai.transitions?.preferred, 4).filter((t): t is (typeof TRANSITION_KINDS)[number] =>
              (TRANSITION_KINDS as readonly string[]).includes(t)
            )
          : [],
        confidence: visionOk && ai.transitions?.preferred ? aiConf(0.7) : 0,
        evidence: ev,
      },
      intensity: {
        value: tierOrUnknown(ai.transitions?.intensity),
        confidence: visionOk && ai.transitions?.intensity ? aiConf(0.7) : 0,
        evidence: ev,
      },
    },
    audio: {
      musicEnergy: {
        value: tierOrUnknown(ai.audio?.musicEnergy),
        confidence: visionOk && ai.audio?.musicEnergy ? aiConf(0.5) : 0,
        evidence: [...ev, 'audio judged from visual context only; not acoustic analysis'],
      },
      sfxDensity: {
        value: tierOrUnknown(ai.audio?.sfxDensity),
        confidence: visionOk && ai.audio?.sfxDensity ? aiConf(0.4) : 0,
        evidence: [...ev, 'audio judged from visual context only; not acoustic analysis'],
      },
      loudnessRange: {
        value: num(m.loudnessRange, 0, 40),
        confidence: m.loudnessRange === null ? 0 : 0.85,
        evidence: m.loudnessRange === null ? [] : ['ffmpeg ebur128 loudness range (LRA)'],
      },
      integratedLoudness: {
        value: num(m.integratedLoudness, -70, 0),
        confidence: m.integratedLoudness === null ? 0 : 0.85,
        evidence: m.integratedLoudness === null ? [] : ['ffmpeg ebur128 integrated loudness'],
      },
    },
    editing: {
      hookStructure: { value: cleanText(ai.editing?.hookStructure), confidence: visionOk && cleanText(ai.editing?.hookStructure) ? aiConf(0.6) : 0, evidence: ev },
      introPattern: { value: cleanText(ai.editing?.introPattern), confidence: visionOk && cleanText(ai.editing?.introPattern) ? aiConf(0.6) : 0, evidence: ev },
      outroPattern: { value: cleanText(ai.editing?.outroPattern), confidence: visionOk && cleanText(ai.editing?.outroPattern) ? aiConf(0.6) : 0, evidence: ev },
    },
    confidence: 0,
    model: input.model,
    promptVersion: input.promptVersion ?? 1,
    generatedAt: new Date().toISOString(),
  };

  profile.confidence = overallConfidence(profile);
  return STYLE_PROFILE_SCHEMA.parse(profile);
}

/** Mean confidence across every observable that carries evidence. */
export function overallConfidence(profile: StyleProfile): number {
  const values: number[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.confidence === 'number' && 'value' in obj) {
      values.push(obj.confidence);
      return;
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(profile);
  if (!values.length) return 0;
  return round(values.reduce((a, b) => a + b, 0) / values.length, 3);
}

export interface ProfileSummaryItem {
  feature: string;
  value: string;
  confidence: number;
}

/** Flatten a profile into feature/value rows for retrieval + prompt injection. */
export function profileFeatures(profile: StyleProfile): ProfileSummaryItem[] {
  const out: ProfileSummaryItem[] = [];
  const push = (feature: string, obs: { value: unknown; confidence: number }) => {
    if (obs.confidence <= 0) return;
    const v = obs.value;
    if (v === null || v === undefined || v === 'unknown') return;
    out.push({ feature, value: Array.isArray(v) ? v.join(',') : String(v), confidence: round(obs.confidence, 3) });
  };
  push('category', { value: profile.category.join(','), confidence: profile.category.length ? 0.8 : 0 });
  push('colorGrade', profile.visualStyle.colorGrade);
  push('brightness', profile.visualStyle.brightness);
  push('contrast', profile.visualStyle.contrast);
  push('saturation', profile.visualStyle.saturation);
  push('typography', profile.visualStyle.typography);
  push('motionGraphics', profile.visualStyle.motionGraphics);
  push('graphicDensity', profile.visualStyle.graphicDensity);
  push('cameraMovement', profile.camera.movement);
  push('zoomFrequency', profile.camera.zoomFrequency);
  push('zoomIntensity', profile.camera.zoomIntensity);
  push('framingVariation', profile.camera.framingVariation);
  push('subjectPriority', profile.camera.subjectPriority);
  push('averageShotDuration', profile.pacing.averageShotDuration);
  push('cutCpm', profile.pacing.cutCpm);
  push('dynamicPacing', profile.pacing.dynamicPacing);
  push('subtitleStyle', profile.subtitles.style);
  push('subtitleWordsPerGroup', profile.subtitles.maxWordsPerGroup);
  push('subtitleHighlight', profile.subtitles.highlightMode);
  push('transitions', profile.transitions.preferred);
  push('transitionIntensity', profile.transitions.intensity);
  push('musicEnergy', profile.audio.musicEnergy);
  push('sfxDensity', profile.audio.sfxDensity);
  push('loudnessRange', profile.audio.loudnessRange);
  return out;
}

/** Find one feature's observation in a profile by its flattened name. */
export function featureValue(profile: StyleProfile, feature: string): { value: unknown; confidence: number } | null {
  const found = profileFeatures(profile).find((f) => f.feature === feature);
  return found ? { value: found.value, confidence: found.confidence } : null;
}

export function tierRank(tier: Tier | 'unknown'): number | null {
  const i = (TIERS as readonly string[]).indexOf(tier);
  return i === -1 ? null : i / (TIERS.length - 1);
}

export function rankToTier(rank: number): Tier {
  const idx = Math.round(Math.min(1, Math.max(0, rank)) * (TIERS.length - 1));
  return TIERS[idx];
}
