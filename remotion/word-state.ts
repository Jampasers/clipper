/* Pure caption layout/timing logic, shared by the Remotion composition and unit tests. */

export type CaptionAnimation = 'none' | 'pop' | 'bounce' | 'fade' | 'slide' | 'shake';

export interface CaptionWordStyle {
  role: string;
  color?: string;
  scale?: number;
  fontWeight?: number;
  animation: CaptionAnimation;
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  style?: CaptionWordStyle;
}

/** Structural twin of SubtitleEvent from src/services/subtitles.ts — kept local so
 *  the Remotion bundle never imports server code. */
export interface CaptionEvent {
  start: number;
  end: number;
  lines: string[];
  words: CaptionWord[] | null;
  emphasisWords: string[];
}

export interface LaidWord { text: string; start: number; end: number; emphasis: boolean; style?: CaptionWordStyle }
export interface LaidEvent { start: number; end: number; lines: LaidWord[][] }

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '');
}

function synthetic(flat: string[], ev: CaptionEvent): CaptionWord[] {
  const n = Math.max(1, flat.length);
  const d = Math.max(0.01, ev.end - ev.start);
  return flat.map((text, i) => ({
    text,
    start: ev.start + (d * i) / n,
    end: ev.start + (d * (i + 1)) / n,
  }));
}

function takeTiming(timings: CaptionWord[], text: string, used: Set<number>): CaptionWord {
  const byText = timings.findIndex((t, i) => !used.has(i) && norm(t.text) === norm(text));
  const i = byText >= 0 ? byText : timings.findIndex((_, j) => !used.has(j));
  if (i >= 0) {
    used.add(i);
    return timings[i];
  }
  return { text, start: 0, end: 0 };
}

/** Assign word timing + emphasis flags to the wrapped lines of one subtitle event.
 *  Matching by normalized text mirrors the old ASS renderLine; without word
 *  timings words get an even slice of the event (typewriter fallback). */
export function layoutEvent(ev: CaptionEvent, emphasisOn: boolean): LaidEvent {
  const targets = new Set(ev.emphasisWords.map(norm));
  const flat = ev.lines.flatMap((l) => l.split(/\s+/).filter(Boolean));
  const timings = ev.words && ev.words.length ? ev.words : synthetic(flat, ev);
  const used = new Set<number>();
  return {
    start: ev.start,
    end: ev.end,
    lines: ev.lines.map((line) =>
      line
        .split(/\s+/)
        .filter(Boolean)
        .map((text) => {
          const w = takeTiming(timings, text, used);
          return {
            text,
            start: w.start,
            end: w.end,
            emphasis: emphasisOn && targets.has(norm(text)),
            style: w.style,
          };
        })
    ),
  };
}

const neutral = { opacity: 1, scale: 1, translateY: 0, translateX: 0 };

/**
 * Deterministic word entrance animation, evaluated purely from the current frame.
 * No randomness: the same frame always renders the same pixels.
 */
export function wordAnimation(animation: CaptionAnimation, localFrame: number, fps: number): typeof neutral {
  if (localFrame < 0) return { ...neutral, opacity: 0 };
  const p = Math.min(1, localFrame / Math.max(1, Math.round(fps * 0.18)));
  const decay = Math.max(0, 1 - localFrame / Math.max(1, Math.round(fps * 0.35)));
  switch (animation) {
    case 'pop':
      return { ...neutral, scale: 1 + 0.3 * (1 - p) };
    case 'bounce': {
      const s = Math.abs(Math.sin(localFrame / 1.6)) * 0.35 * decay;
      return { ...neutral, scale: 1 + s };
    }
    case 'fade':
      return { ...neutral, opacity: p };
    case 'slide':
      return { ...neutral, translateY: 18 * (1 - p), opacity: Math.max(0.001, p) };
    case 'shake': {
      const x = Math.sin(localFrame * 2.4) * 4 * decay;
      return { ...neutral, translateX: x };
    }
    case 'none':
    default:
      return { ...neutral };
  }
}
