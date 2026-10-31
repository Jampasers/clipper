import type { EdlStyle, GradeName, TransitionType } from './edl.js';
import type { SceneAnalysis } from './scene-analysis.js';
import { cutsPerMinute } from './scene-analysis.js';

/**
 * Adaptive Style Engine. Turns local signals (aspect mismatch, scene analysis,
 * speech density, duration) into one deterministic style profile. The Creative
 * Director may override individual switches, but the profile itself is always
 * computed in code so renders stay reproducible and safe.
 */

export interface StyleSignals {
  aspect: '9:16' | '16:9' | '1:1';
  /** source frame aspect (width/height), 0 when unknown */
  sourceAspect: number;
  duration: number;
  scene: SceneAnalysis | null;
  hasHook: boolean;
  /** spoken words per second inside the clip (0 when no transcript) */
  speechRate: number;
  hasBrollLibrary: boolean;
}

export function targetAspect(aspect: '9:16' | '16:9' | '1:1'): number {
  if (aspect === '9:16') return 9 / 16;
  if (aspect === '16:9') return 16 / 9;
  return 1;
}

export interface GradeProfile {
  name: GradeName;
  /** ffmpeg `eq` numbers */
  eq: { brightness: number; contrast: number; saturation: number; gamma: number };
  /** normalized `colorbalance` deltas, all within sane limits */
  balance: { r: number; g: number; b: number };
  vignette: number;
}

/** Deterministic grade presets. Values are conservative (short-form compliance). */
export const GRADE_PROFILES: Record<GradeName, GradeProfile> = {
  none: { name: 'none', eq: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 }, balance: { r: 0, g: 0, b: 0 }, vignette: 0 },
  warm: {
    name: 'warm',
    eq: { brightness: 0.03, contrast: 1.05, saturation: 1.08, gamma: 1.02 },
    balance: { r: 0.07, g: 0.0, b: -0.05 },
    vignette: 0,
  },
  cool: {
    name: 'cool',
    eq: { brightness: 0.0, contrast: 1.04, saturation: 1.04, gamma: 0.99 },
    balance: { r: -0.05, g: 0.0, b: 0.07 },
    vignette: 0,
  },
  vivid: {
    name: 'vivid',
    eq: { brightness: 0.01, contrast: 1.09, saturation: 1.16, gamma: 1.0 },
    balance: { r: 0.0, g: 0.0, b: 0.0 },
    vignette: 0,
  },
  cinematic: {
    name: 'cinematic',
    eq: { brightness: 0.0, contrast: 1.07, saturation: 0.98, gamma: 0.98 },
    balance: { r: -0.04, g: 0.0, b: 0.04 },
    vignette: 0.35,
  },
};

export function gradeFilters(profile: GradeProfile): string[] {
  const f: string[] = [];
  const { eq, balance } = profile;
  if (eq.brightness || eq.contrast !== 1 || eq.saturation !== 1 || eq.gamma !== 1) {
    f.push(
      `eq=brightness=${eq.brightness.toFixed(3)}:contrast=${eq.contrast.toFixed(3)}:saturation=${eq.saturation.toFixed(3)}:gamma=${eq.gamma.toFixed(3)}`
    );
  }
  if (balance.r || balance.g || balance.b) {
    f.push(`colorbalance=rs=${balance.r.toFixed(3)}:gs=${balance.g.toFixed(3)}:bs=${balance.b.toFixed(3)}`);
  }
  if (profile.vignette > 0) f.push(`vignette=PI/${Math.max(3, Math.round(4 / profile.vignette))}`);
  return f;
}

/**
 * Choose the style profile. Rules of thumb (deterministic):
 *  - subject visible (faces present) -> punch-in allowed; otherwise off
 *  - very wide source rendered into a tall target with no faces -> blurred fill
 *  - dark footage -> warm (lifts shadows), flat footage -> vivid, dynamic cut
 *    heavy footage -> cinematic, otherwise none
 *  - hook present -> fade transition (matches the crossfade), else slide-free fade
 */
export function chooseStyle(signals: StyleSignals): EdlStyle {
  const scene = signals.scene;
  const faces = scene ? scene.faceCoverage : 0;
  const cpm = scene ? cutsPerMinute(scene) : 0;
  const srcA = signals.sourceAspect > 0 ? signals.sourceAspect : 0;

  const punchIn = faces >= 0.3 && signals.duration >= 6;
  let backgroundFill: EdlStyle['backgroundFill'] = 'crop';
  if (srcA > 0 && srcA >= targetAspect(signals.aspect) * 1.35 && faces < 0.2) {
    // very wide footage into a narrow frame and nobody to track: blur-pad beats
    // aggressively cropping away two thirds of the picture
    backgroundFill = 'fill-blur';
  }

  let grade: GradeName = 'none';
  if (scene?.dark) grade = 'warm';
  else if (scene?.bright) grade = 'cool';
  else if (cpm >= 6) grade = 'cinematic';
  else if (signals.speechRate >= 2.2 || signals.duration <= 20) grade = 'vivid';

  const transition: { type: TransitionType; duration: number } = {
    type: signals.hasHook ? 'fade' : cpm >= 8 ? 'slide' : 'fade',
    duration: signals.hasHook ? 0.5 : 0.35,
  };

  return {
    grade,
    backgroundFill,
    punchIn,
    transition,
    edgeFade: !signals.hasHook,
    progressBar: signals.duration >= 18,
    accentColor: '#FFD400',
  };
}

/** Rough speech rate (words/sec) over a clip window, used as an energy proxy. */
export function speechRate(words: { start: number; end: number }[] | null | undefined, clipStart: number, clipEnd: number): number {
  if (!words?.length) return 0;
  const inside = words.filter((w) => w.end > clipStart && w.start < clipEnd);
  const dur = Math.max(1, clipEnd - clipStart);
  return Math.round((inside.length / dur) * 100) / 100;
}
