import { q, J } from '../lib/sqlite.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';
import {
  getLatestAnalysis, listReferences, referenceUsageStats, type ReferenceRow,
} from './reference-library.js';
import {
  STYLE_PROFILE_SCHEMA, profileFeatures, tierRank, OVERLAY_POSITIONS, type StyleProfile, type Tier,
} from './style-profile.js';
import {
  resolvePreferences, currentInsights, detectContextKey, valueLabel, FEATURE_SPECS,
  type PreferenceFeature, type ResolvedPreference,
} from './learning.js';
import type { SceneAnalysis } from './scene-analysis.js';

/**
 * Reference Retrieval Engine.
 *
 * Never injects the whole library: selects at most `max_references` (configurable)
 * by a hybrid score — content / editing-style / preference / visual-composition /
 * historical performance — each term independently testable. Only the relevant
 * features of each selected reference are returned.
 */

export interface RetrievalInput {
  title: string | null;
  transcriptText: string | null;
  scene: SceneAnalysis | null;
  duration: number;
  hasSpeech: boolean;
  hasAudio: boolean;
  graphicsEnabled: boolean;
  /** optional precomputed context key (otherwise detected here) */
  contextKey?: string;
  category?: string | null;
}

export interface RetrievalParts {
  content: number;
  style: number;
  preference: number;
  visual: number;
  history: number;
}

export interface RetrievedReference {
  id: string;
  name: string;
  category: string | null;
  score: number;
  parts: RetrievalParts;
  profile: StyleProfile;
  features: { feature: string; value: string; confidence: number }[];
  usage: { uses: number; good: number; bad: number };
}

export interface AdaptiveConstraints {
  maxFramings: number | null;
  /** floor: pad framings up to this when references/learned taste want punchier zoom */
  minFramings: number | null;
  shotCeiling: 'wide' | 'medium' | 'close' | null;
  maxBroll: number | null;
  maxSfx: number | null;
  /** floor: insert this many sfx placements at cuts when the model produced fewer */
  sfxBaseline: number | null;
  maxGraphics: number | null;
  maxEmphasis: number | null;
  preferredGrade: string | null;
  preferredTransition: string | null;
  preferredSubtitleStyle: string | null;
  /** graphic/text placement target for titles (top/center/bottom) */
  titlePosition: 'top' | 'center' | 'bottom' | null;
  musicIntensity: string | null;
  pacingHint: string | null;
}

export interface VisualLearningContext {
  contextKey: string;
  references: RetrievedReference[];
  preferences: { feature: string; value: string | number; confidence: number; contextKey: string; source: string }[];
  insights: string[];
  constraints: AdaptiveConstraints;
  /** majority style targets derived from the selected references (soft defaults) */
  consensus?: Record<string, string>;
  notes: string[];
}

/* ---------------- text similarity (deterministic) ---------------- */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'it', 'this', 'that', 'you', 'i', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'dan', 'yang',
  'di', 'ke', 'dari', 'untuk', 'ini', 'itu', 'dengan', 'ada', 'tidak', 'saya', 'kamu', 'kita',
]);

export function tokenize(text: string | null | undefined, max = 60): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits++;
  return Math.min(1, hits / Math.min(8, a.length));
}

/* ---------------- profile/target comparison helpers ---------------- */

const TIER_ORDER = ['very_low', 'low', 'medium', 'medium_high', 'high', 'very_high'] as const;

function tierDistance(a: Tier | 'unknown', b: Tier | 'unknown'): number | null {
  const ra = tierRank(a);
  const rb = tierRank(b);
  if (ra === null || rb === null) return null;
  return Math.abs(ra - rb);
}

function featureOf(profile: StyleProfile, feature: string): { value: unknown; confidence: number } | null {
  const found = profileFeatures(profile).find((f) => f.feature === feature);
  return found ? { value: found.value, confidence: found.confidence } : null;
}

/** Scene-derived tier targets (deterministic, from local measurements only). */
export function sceneTierTarget(scene: SceneAnalysis | null): { cut: Tier | 'unknown' } {
  if (!scene) return { cut: 'unknown' };
  const window = (scene.windowEnd ?? 0) - (scene.windowStart ?? 0);
  const span = window > 0 ? window : Number((scene as unknown as { duration?: number }).duration) || 0;
  if (!(span > 0)) return { cut: 'unknown' };
  const cpm = ((scene.cuts?.length ?? 0) / span) * 60;
  const cut: Tier = cpm < 1 ? 'very_low' : cpm < 3 ? 'low' : cpm < 6 ? 'medium' : cpm < 10 ? 'medium_high' : cpm < 18 ? 'high' : 'very_high';
  return { cut };
}

function prefTier(prefs: Map<PreferenceFeature, ResolvedPreference>, feature: PreferenceFeature): Tier | 'unknown' {
  const p = prefs.get(feature);
  if (!p || p.value.kind !== 'tier') return 'unknown';
  return p.value.value as Tier;
}

/* ---------------- scoring ---------------- */

export function scoreReference(
  ref: ReferenceRow,
  profile: StyleProfile,
  input: RetrievalInput,
  prefs: Map<PreferenceFeature, ResolvedPreference>,
  opts: { weights?: { content: number; style: number; preference: number; visual: number; history: number } } = {}
): { score: number; parts: RetrievalParts } {
  const settings = getSettings('learning');
  const weights = opts.weights ?? settings.weights;

  // 1. content similarity — transcript/title keywords vs reference identity
  const clipTokens = tokenize(`${input.title ?? ''} ${input.transcriptText ?? ''}`.slice(0, 4000));
  const refTokens = tokenize(`${ref.name} ${ref.description ?? ''} ${(J.read<string[]>(ref.tags) ?? []).join(' ')} ${ref.category ?? ''}`);
  const content = overlapScore(clipTokens, refTokens);

  // 2. editing style similarity — reference pacing/zoom vs clip's own scene + user pacing prefs
  const sceneTarget = sceneTierTarget(input.scene).cut;
  const pacingPref = prefs.get('pacing');
  const userPacing = pacingPref && pacingPref.value.kind === 'categorical' ? String(pacingPref.value.value) : null;
  const pacingTarget: Tier | 'unknown' =
    userPacing === 'slow' ? 'low' : userPacing === 'fast' ? 'high' : userPacing === 'medium' ? 'medium_high' : sceneTarget;
  const refCut = (featureOf(profile, 'cutCpm')?.value as string | undefined) ?? 'unknown';
  const cutNum = typeof refCut === 'string' && refCut !== 'unknown' ? Number(refCut) : NaN;
  const refCutTier: Tier | 'unknown' = Number.isFinite(cutNum)
    ? cutNum < 1
      ? 'very_low'
      : cutNum < 3
        ? 'low'
        : cutNum < 6
          ? 'medium'
          : cutNum < 10
            ? 'medium_high'
            : cutNum < 18
              ? 'high'
              : 'very_high'
    : 'unknown';
  const pacingDist = tierDistance(refCutTier, pacingTarget);
  const zoomPref = prefTier(prefs, 'zoom_frequency');
  const refZoom = (profile.camera.zoomFrequency.value as Tier | 'unknown') ?? 'unknown';
  const zoomDist = tierDistance(refZoom, zoomPref);
  const styleTerms = [pacingDist, zoomDist].filter((d): d is number => d !== null);
  const style = styleTerms.length ? 1 - styleTerms.reduce((a, b) => a + b, 0) / styleTerms.length : 0.4;

  // 3. preference match — how close the reference features sit to learned prefs
  const preference = preferenceMatch(profile, prefs);

  // 4. visual composition similarity — brightness/face coverage/subject priority
  const visual = visualMatch(profile, input.scene);

  // 5. historical performance — usage outcomes
  const usage = referenceUsageStats(ref.id);
  const decided = usage.good + usage.bad;
  const history = decided === 0 ? 0.5 : usage.good / decided;

  const total = weights.content + weights.style + weights.preference + weights.visual + weights.history || 1;
  const score =
    (content * weights.content + style * weights.style + preference * weights.preference + visual * weights.visual + history * weights.history) / total;
  return {
    score: Math.round(score * 1000) / 1000,
    parts: {
      content: Math.round(content * 1000) / 1000,
      style: Math.round(style * 1000) / 1000,
      preference: Math.round(preference * 1000) / 1000,
      visual: Math.round(visual * 1000) / 1000,
      history: Math.round(history * 1000) / 1000,
    },
  };
}

function preferenceMatch(profile: StyleProfile, prefs: Map<PreferenceFeature, ResolvedPreference>): number {
  if (!prefs.size) return 0.5; // neutral when nothing has been learned yet
  let total = 0;
  let n = 0;
  const compareTier = (feature: PreferenceFeature, value: unknown) => {
    const pref = prefs.get(feature);
    if (!pref || pref.value.kind !== 'tier' || typeof value !== 'string') return;
    const d = tierDistance(value as Tier, pref.value.value as Tier);
    if (d === null) return;
    total += (1 - d) * pref.confidence;
    n += pref.confidence;
  };
  compareTier('zoom_frequency', profile.camera.zoomFrequency.value);
  compareTier('broll_density', profile.visualStyle.graphicDensity.value);
  compareTier('motion_graphics', profile.visualStyle.motionGraphics.value);
  compareTier('sfx_density', profile.audio.sfxDensity.value);
  compareTier('music_intensity', profile.audio.musicEnergy.value);

  const gradePref = prefs.get('color_grade');
  if (gradePref && gradePref.value.kind === 'categorical' && profile.visualStyle.colorGrade.value !== 'unknown') {
    const refGrade = String(profile.visualStyle.colorGrade.value);
    const want = String(gradePref.value.value);
    const matches = refGrade === want || refGrade.includes(want) || want.includes(refGrade);
    total += (matches ? 1 : 0.25) * gradePref.confidence;
    n += gradePref.confidence;
  }
  const subtitlePref = prefs.get('subtitle_style');
  if (subtitlePref && subtitlePref.value.kind === 'categorical' && profile.subtitles.style.value !== 'unknown') {
    const refStyle = String(profile.subtitles.style.value);
    const want = String(subtitlePref.value.value);
    total += (refStyle === want || want === 'ai' ? 1 : 0.3) * subtitlePref.confidence;
    n += subtitlePref.confidence;
  }
  if (n === 0) return 0.5;
  return Math.min(1, Math.max(0, total / n));
}

function visualMatch(profile: StyleProfile, scene: SceneAnalysis | null): number {
  const terms: number[] = [];
  if (scene && scene.avgBrightness > 0 && profile.visualStyle.brightness.value !== null) {
    const clipBrightness = scene.avgBrightness / 255;
    terms.push(1 - Math.min(1, Math.abs(clipBrightness - (profile.visualStyle.brightness.value ?? clipBrightness)) * 2));
  }
  if (scene) {
    const framing = profile.camera.framingVariation.value;
    const faceHeavy = scene.faceCoverage >= 0.4;
    if (framing === 'high' || framing === 'very_high') terms.push(faceHeavy ? 0.85 : 0.5);
    else if (framing === 'low' || framing === 'very_low') terms.push(faceHeavy ? 0.55 : 0.8);
  }
  if (!terms.length) return 0.5;
  return Math.min(1, Math.max(0, terms.reduce((a, b) => a + b, 0) / terms.length));
}

/* ---------------- feature-level selection ---------------- */

const FEATURE_GROUPS: Record<string, string[]> = {
  pacing: ['averageShotDuration', 'cutCpm', 'dynamicPacing'],
  camera: ['cameraMovement', 'zoomFrequency', 'zoomIntensity', 'framingVariation', 'subjectPriority'],
  look: ['colorGrade', 'brightness', 'contrast', 'saturation', 'typography'],
  subtitles: ['subtitleStyle', 'subtitleWordsPerGroup', 'subtitleHighlight'],
  transitions: ['transitions', 'transitionIntensity'],
  audio: ['musicEnergy', 'sfxDensity', 'loudnessRange'],
  graphics: ['motionGraphics', 'graphicDensity'],
};

export function selectRelevantFeatures(profile: StyleProfile, input: RetrievalInput): { feature: string; value: string; confidence: number }[] {
  const groups = ['pacing', 'camera', 'look', 'transitions'];
  if (input.hasSpeech) groups.push('subtitles');
  if (input.hasAudio) groups.push('audio');
  if (input.graphicsEnabled) groups.push('graphics');
  const wanted = new Set(groups.flatMap((g) => FEATURE_GROUPS[g]));
  return profileFeatures(profile)
    .filter((f) => wanted.has(f.feature) && f.feature !== 'category')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);
}

/* ---------------- retrieval + context building ---------------- */

export function retrieveReferences(input: RetrievalInput): RetrievedReference[] {
  const settings = getSettings('learning');
  if (!settings.enabled || !settings.use_references) return [];
  const contextKey = input.contextKey ?? detectContextKey({ title: input.title, transcriptText: input.transcriptText, category: input.category });
  const prefs = resolvePreferences(contextKey);
  const { references } = listReferences({ enabledOnly: true, limit: 200 });
  const scored: RetrievedReference[] = [];
  for (const ref of references) {
    const analysis = getLatestAnalysis(ref.id);
    const profile = analysis ? J.read<StyleProfile>(analysis.profile) : null;
    if (!profile) continue;
    const parsed = STYLE_PROFILE_SCHEMA.safeParse(profile);
    if (!parsed.success) continue;
    const { score, parts } = scoreReference(ref, parsed.data, { ...input, contextKey }, prefs);
    if (score < settings.min_reference_score) continue;
    scored.push({
      id: ref.id,
      name: ref.name,
      category: ref.category,
      score,
      parts,
      profile: parsed.data,
      features: selectRelevantFeatures(parsed.data, input),
      usage: referenceUsageStats(ref.id),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = scored.slice(0, Math.max(0, settings.max_references));
  if (selected.length) {
    logger.info(
      'AI',
      `reference retrieval: context=${contextKey || 'global'} selected ${selected
        .map((r) => `${r.id}(${r.score})`)
        .join(', ')} of ${scored.length} candidates`
    );
  }
  return selected;
}

/* ---------------- configured, deterministic constraints ---------------- */

const DENSITY_CAP: Record<string, number> = { none: 0, very_low: 0, low: 1, medium: 3, medium_high: 4, high: 6, very_high: 8 };

/** Reference color grades are richer than the preference options; map to the closest preferred grade. */
const GRADE_TO_PREF: Record<string, string> = {
  warm: 'warm', high_contrast_warm: 'warm',
  cool: 'cool', high_contrast_cool: 'cool',
  vivid: 'vivid', desaturated: 'cinematic', cinematic: 'cinematic',
  neutral: 'none',
};

const SUBTITLE_TO_PREF: Record<string, string> = {
  none: 'none', static: 'classic', bold_uppercase: 'bold', karaoke: 'karaoke', kinetic: 'kinetic', word_by_word: 'karaoke',
};

const TRANSITION_TO_PREF: Record<string, string> = { cut: 'cut', fade: 'fade', slide: 'slide', whip: 'slide' };

/**
 * Deterministic soft targets from the selected reference pool: a feature is only
 * adopted when a strict majority (>= 2 and > half) of the references agree.
 * Manual and learned preferences override these in buildConstraints.
 */
export function referenceConsensus(refs: RetrievedReference[]): Record<string, string> {
  const votes = new Map<string, Map<string, number>>();
  const valid = (feature: PreferenceFeature, value: string): boolean => {
    const spec = FEATURE_SPECS[feature];
    if (spec.kind === 'categorical') return !!spec.options?.includes(value);
    if (spec.kind === 'tier') return (TIER_ORDER as readonly string[]).includes(value);
    return false;
  };
  const vote = (feature: string, raw: unknown, toPref?: Record<string, string>) => {
    if (typeof raw !== 'string' || !raw || raw === 'unknown') return;
    const value = toPref ? toPref[raw] : raw;
    if (!value) return;
    if (feature === 'overlay_position') {
      if (!(OVERLAY_POSITIONS as readonly string[]).includes(value) || value === 'mixed') return;
    } else if (!valid(feature as PreferenceFeature, value)) return;
    const counts = votes.get(feature) ?? new Map<string, number>();
    counts.set(value, (counts.get(value) ?? 0) + 1);
    votes.set(feature, counts);
  };
  for (const r of refs) {
    const p = r.profile;
    // Every feature here has a real deterministic application in applyLearningConstraints.
    vote('zoom_frequency', p.camera.zoomFrequency.value);
    vote('motion_graphics', p.visualStyle.motionGraphics.value);
    vote('color_grade', p.visualStyle.colorGrade.value, GRADE_TO_PREF);
    vote('music_intensity', p.audio.musicEnergy.value);
    vote('sfx_density', p.audio.sfxDensity.value);
    vote('subtitle_style', p.subtitles.style.value, SUBTITLE_TO_PREF);
    vote('overlay_position', p.visualStyle.overlayPosition.value);
    // Transition preference: take the first kind the analysis ranked, mapped to EDL vocabulary.
    const kinds = p.transitions.preferred.value;
    if (Array.isArray(kinds)) vote('transition_preference', kinds.find((k) => TRANSITION_TO_PREF[k]), TRANSITION_TO_PREF);
  }
  const out: Record<string, string> = {};
  for (const [feature, counts] of votes) {
    let best = '';
    let bestN = 0;
    let total = 0;
    for (const [value, n] of counts) {
      total += n;
      if (n > bestN) { best = value; bestN = n; }
    }
    if (best && bestN >= 2 && bestN * 2 > total) out[feature] = best;
  }
  return out;
}

export function buildConstraints(prefs: Map<PreferenceFeature, ResolvedPreference>, consensus: Record<string, string> = {}): AdaptiveConstraints {
  const constraints: AdaptiveConstraints = {
    maxFramings: null,
    minFramings: null,
    shotCeiling: null,
    maxBroll: null,
    maxSfx: null,
    sfxBaseline: null,
    maxGraphics: null,
    maxEmphasis: null,
    preferredGrade: null,
    preferredTransition: null,
    preferredSubtitleStyle: null,
    titlePosition: null,
    musicIntensity: null,
    pacingHint: null,
  };
  const tierPref = (f: PreferenceFeature): Tier | null => {
    const p = prefs.get(f);
    if (p && p.value.kind === 'tier') return p.value.value as Tier;
    const c = consensus[f];
    return c && (TIER_ORDER as readonly string[]).includes(c) ? (c as Tier) : null;
  };
  const catPref = (f: PreferenceFeature) => {
    const p = prefs.get(f);
    if (p && p.value.kind === 'categorical') return String(p.value.value);
    return consensus[f] ?? null;
  };
  const numPref = (f: PreferenceFeature) => {
    const p = prefs.get(f);
    return p && p.value.kind === 'numeric' ? (p.value.value as number) : null;
  };

  const zoomFreqRank = (() => {
    const t = tierPref('zoom_frequency');
    return t ? tierRank(t) : null;
  })();
  const zoomRank = zoomFreqRank !== null ? zoomFreqRank : numPref('zoom_intensity');
  if (zoomRank !== null) {
    constraints.maxFramings = Math.max(1, Math.round(1 + zoomRank * 5));
    constraints.shotCeiling = zoomRank >= 0.66 ? 'close' : zoomRank >= 0.33 ? 'medium' : 'wide';
    // punchy reference/learned taste also wants MORE zooms, not just fewer
    if (zoomRank >= 0.66) constraints.minFramings = Math.min(6, constraints.maxFramings);
  }
  const broll = catPref('broll_density');
  if (broll) constraints.maxBroll = DENSITY_CAP[broll] ?? null;
  const sfx = catPref('sfx_density');
  if (sfx) {
    const cap = DENSITY_CAP[sfx];
    constraints.maxSfx = cap ?? null;
    if (cap !== undefined && cap >= 4) constraints.sfxBaseline = 2;
  }
  const motion = catPref('motion_graphics');
  const complexity = catPref('visual_complexity');
  const graphicsRank = motion ? (DENSITY_CAP[motion] ?? 0) / 8 : complexity ? ({ low: 0.2, medium: 0.5, high: 0.85 } as Record<string, number>)[complexity] ?? null : null;
  if (graphicsRank !== null) constraints.maxGraphics = Math.max(0, Math.round(graphicsRank * 8));
  const density = catPref('subtitle_density');
  if (density) constraints.maxEmphasis = density === 'none' ? 0 : density === 'high' || density === 'very_high' ? 40 : density === 'low' || density === 'very_low' ? 8 : 16;
  const grade = catPref('color_grade');
  if (grade) constraints.preferredGrade = grade;
  const transition = catPref('transition_preference');
  if (transition) constraints.preferredTransition = transition;
  const subtitle = catPref('subtitle_style');
  if (subtitle) constraints.preferredSubtitleStyle = subtitle;
  const music = catPref('music_intensity');
  if (music) constraints.musicIntensity = music;
  const pacing = catPref('pacing');
  if (pacing) constraints.pacingHint = pacing;
  const overlay = consensus['overlay_position'];
  if (overlay && (OVERLAY_POSITIONS as readonly string[]).includes(overlay) && overlay !== 'mixed') {
    constraints.titlePosition = overlay as 'top' | 'center' | 'bottom';
  }
  return constraints;
}

/**
 * Build the validated context handed to the Creative Director. Returns null when
 * learning is disabled and nothing has been learned yet, so basic behaviour is
 * untouched.
 */
export function buildVisualLearningContext(input: RetrievalInput): VisualLearningContext | null {
  const settings = getSettings('learning');
  if (!settings.enabled) return null;
  const contextKey = input.contextKey ?? detectContextKey({ title: input.title, transcriptText: input.transcriptText, category: input.category });
  const prefs = resolvePreferences(contextKey);
  const refs = retrieveReferences({ ...input, contextKey });
  const insights = currentInsights(5);
  if (!refs.length && !prefs.size && !insights.length) return null;

  const notes: string[] = [];
  if (!refs.length) notes.push('no reference styles cleared the relevance threshold; proceeding with learned preferences only');

  const consensus = referenceConsensus(refs);
  if (Object.keys(consensus).length) {
    notes.push(
      `reference consensus targets (soft, manual/learned preferences override): ${Object.entries(consensus).map(([f, v]) => `${f}=${v}`).join(', ')}`
    );
  }

  return {
    contextKey,
    references: refs,
    preferences: [...prefs.values()].map((p) => ({
      feature: p.feature,
      value: typeof p.value.value === 'number' ? p.value.value : String(p.value.value),
      confidence: p.confidence,
      contextKey: p.contextKey,
      source: p.source,
    })),
    insights,
    constraints: buildConstraints(prefs, consensus),
    consensus,
    notes,
  };
}

/** Keep the injected prompt payload small and cheap. */
export function compactLearningContext(ctx: VisualLearningContext): Record<string, unknown> {
  return {
    context: ctx.contextKey || 'global',
    references: ctx.references.map((r) => ({
      name: r.name,
      relevance: r.score,
      style: Object.fromEntries(r.features.map((f) => [f.feature, f.value])),
    })),
    learned_preferences: Object.fromEntries(ctx.preferences.map((p) => [`${p.feature}${p.contextKey ? `@${p.contextKey}` : ''}`, p.value])),
    preference_confidence: Object.fromEntries(ctx.preferences.map((p) => [p.feature, p.confidence])),
    insights: ctx.insights,
    constraints: ctx.constraints,
    notes: ctx.notes,
  };
}

export function contextSummary(ctx: VisualLearningContext | null): string {
  if (!ctx) return 'none';
  const refs = ctx.references.map((r) => `${r.name}(${r.score})`).join(', ') || 'none';
  const prefs = ctx.preferences.map((p) => `${p.feature}=${p.value}`).join(', ') || 'none';
  return `refs=[${refs}] prefs=[${prefs}] context=${ctx.contextKey || 'global'}`;
}

export { valueLabel };
