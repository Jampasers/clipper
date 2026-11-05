/**
 * Tiny color utilities for the design engine (WCAG contrast, mixing).
 * Pure functions, no dependencies — used by layout, review and repair.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
}

export function toHex(c: Rgb): string {
  const v = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${v(c.r)}${v(c.g)}${v(c.b)}`;
}

function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b);
}

/** WCAG contrast ratio 1..21 between two opaque colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isDark(hex: string): boolean {
  return relativeLuminance(hex) < 0.4;
}

/** Pick black or white ink for maximum contrast on a background. */
export function bestInk(background: string, dark = '#111111', light = '#ffffff'): string {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.max(0, Math.min(1, t));
  return toHex({ r: ca.r + (cb.r - ca.r) * k, g: ca.g + (cb.g - ca.g) * k, b: ca.b + (cb.b - ca.b) * k, a: 1 });
}

export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  const v = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${v(c.r)}${v(c.g)}${v(c.b)}${v(a * 255)}`;
}
