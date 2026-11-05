import type { TextLayer } from './document.js';

/**
 * Deterministic typography engine: font metrics approximation, word wrapping,
 * overflow detection and shrink-to-fit. The same measurements are used by the
 * layout engine, the SVG renderer and the deterministic quality review, so all
 * three agree about whether text fits its box.
 */

export interface FontSpec {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  uppercase?: boolean;
}

export const SYSTEM_FONTS = [
  'Arial', 'Arial Black', 'Helvetica', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Georgia', 'Times New Roman', 'Cambria', 'Garamond', 'Courier New', 'Consolas',
  'Impact', 'Franklin Gothic Medium', 'Palatino Linotype', 'Lucida Sans Unicode',
  'system-ui', 'sans-serif', 'serif', 'monospace',
];

const MONO_FONTS = new Set(['Courier New', 'Consolas', 'monospace', 'Lucida Console', 'Cascadia Code']);
const NARROW_FONTS = new Set(['Arial Narrow', 'Tahoma', 'Franklin Gothic Medium', 'Lucida Sans Unicode']);
const WIDE_FONTS = new Set(['Arial Black', 'Impact', 'Verdana']);

type WidthClass = 'mono' | 'narrow' | 'normal' | 'wide';

function widthClass(family: string): WidthClass {
  const f = family.trim().toLowerCase();
  const match = [...MONO_FONTS, ...NARROW_FONTS, ...WIDE_FONTS].find((x) => x.toLowerCase() === f);
  if (!match) return 'normal';
  if (MONO_FONTS.has(match)) return 'mono';
  if (NARROW_FONTS.has(match)) return 'narrow';
  return 'wide';
}

/** Relative width per character (em units) for the normal width class. */
function charWidth(ch: string): number {
  if (ch === ' ') return 0.28;
  if ('iljtfI.,;:!|\'`'.includes(ch)) return 0.3;
  if ('mwMW@%&'.includes(ch)) return 0.85;
  if ('ABCDEFGHKLMNOPQRSTUVWXYZ'.includes(ch)) return 0.66;
  if ('0123456789'.includes(ch)) return 0.58;
  if ('-–—/\\()[]{}<>+=*#$~^_`"'.includes(ch)) return 0.4;
  return 0.55;
}

function weightFactor(weight: number): number {
  if (weight >= 800) return 1.06;
  if (weight >= 600) return 1.03;
  if (weight <= 300) return 0.97;
  return 1;
}

const CLASS_FACTORS: Record<WidthClass, number> = { mono: 1.08, narrow: 0.86, normal: 1, wide: 1.22 };

/** Measured width of a single line, in px. */
export function measureLine(text: string, spec: FontSpec): number {
  const s = spec.uppercase ? text.toUpperCase() : text;
  let em = 0;
  for (const ch of s) em += charWidth(ch);
  const cls = widthClass(spec.fontFamily);
  const base = em * spec.fontSize * CLASS_FACTORS[cls] * weightFactor(spec.fontWeight);
  return base + Math.max(0, s.length - 1) * spec.letterSpacing;
}

/** Greedy word wrap; long unbreakable words are hard-broken. */
export function wrapText(text: string, spec: FontSpec, maxWidth: number): string[] {
  const limit = Math.max(1, Math.floor(maxWidth));
  const paragraphs = String(text).split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureLine(candidate, spec) <= limit || !line) {
        if (measureLine(candidate, spec) > limit && !line) {
          // hard-break a single overlong word
          let chunk = '';
          for (const ch of word) {
            if (measureLine(chunk + ch, spec) > limit && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line || !words.length) lines.push(line);
  }
  return lines.length ? lines : [''];
}

export interface TextMetrics {
  lines: string[];
  width: number;
  height: number;
  lineHeightPx: number;
  overflow: boolean;
}

export function measureTextBlock(text: string, spec: FontSpec, boxWidth: number, boxHeight?: number): TextMetrics {
  const lines = wrapText(text, spec, boxWidth);
  const lineHeightPx = spec.fontSize * spec.lineHeight;
  const width = lines.reduce((max, line) => Math.max(max, measureLine(line, spec)), 0);
  const height = lines.length * lineHeightPx;
  return { lines, width, height, lineHeightPx, overflow: boxHeight !== undefined ? height > boxHeight + 0.5 : false };
}

/**
 * Largest font size (<= requested) that keeps the text inside the box.
 * Deterministic bisection; floors at minSize.
 */
export function fitFontSize(text: string, spec: FontSpec, boxWidth: number, boxHeight: number, minSize = 8): number {
  const fits = (size: number) => {
    const probe = { ...spec, fontSize: size };
    const m = wrapText(text, probe, boxWidth);
    return m.length * size * spec.lineHeight <= boxHeight + 0.5 && m.every((l) => measureLine(l, probe) <= boxWidth + 0.5);
  };
  if (fits(spec.fontSize)) return spec.fontSize;
  let lo = minSize;
  let hi = spec.fontSize;
  if (!fits(lo)) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Resolve the effective spec/lines for a text layer (honours shrink overflow). */
export function resolveTextLayout(layer: TextLayer): { spec: FontSpec; metrics: TextMetrics } {
  const spec: FontSpec = { ...layer.style };
  if (layer.style.overflow === 'shrink') {
    const size = fitFontSize(layer.text, spec, layer.width, layer.height);
    spec.fontSize = size;
  }
  const metrics = measureTextBlock(layer.text, spec, layer.width, layer.height);
  return { spec, metrics };
}

export function isKnownFont(family: string, customFamilies: string[] = []): boolean {
  const f = family.trim().toLowerCase();
  return SYSTEM_FONTS.some((x) => x.toLowerCase() === f) || customFamilies.some((x) => x.toLowerCase() === f);
}
