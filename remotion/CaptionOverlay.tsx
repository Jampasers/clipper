/* Transparent caption overlay; FFmpeg composites this over the cropped video. */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { layoutEvent, wordAnimation, type CaptionEvent, type CaptionAnimation } from './word-state';

export interface CaptionPreset {
  font: string;
  font_size: number;
  position: 'bottom' | 'middle' | 'top';
  margin_v: number;
  primary_color: string;
  outline_color: string;
  outline_width: number;
  bold: boolean;
  uppercase: boolean;
  karaoke: boolean;
  karaoke_color: string;
  animation: 'none' | 'fade' | 'typewriter';
}

export interface CaptionEmphasis {
  enabled: boolean;
  color: string;
  scale_percent: number;
  bold: boolean;
}

export interface CaptionOverlayProps {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  events: CaptionEvent[];
  preset: CaptionPreset;
  emphasis: CaptionEmphasis;
  /** ai | bold | karaoke | kinetic */
  mode?: string;
  /** master switch for word animations (per-render option) */
  animations?: boolean;
}

function outlineShadows(w: number, color: string): string {
  if (w <= 0) return 'none';
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  return dirs.map(([x, y]) => `${x * w}px ${y * w}px 0 ${color}, ${x * w}px ${y * w}px ${w}px ${color}`).join(', ');
}

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({ events, preset, emphasis, mode = 'ai', animations = true }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;
  const doKaraoke = preset.karaoke || preset.animation === 'typewriter' || mode === 'karaoke';
  const isKinetic = mode === 'kinetic' && animations;
  const justify = preset.position === 'top' ? 'flex-start' : preset.position === 'middle' ? 'center' : 'flex-end';

  return (
    <AbsoluteFill>
      {events.map((raw, i) => {
        const ev = layoutEvent(raw, emphasis.enabled);
        if (t < ev.start || t >= ev.end) return null;
        const dur = Math.max(0.3, ev.end - ev.start);
        const fade = Math.min(0.35, dur / 3);
        const opacity =
          preset.animation === 'fade'
            ? interpolate(t, [ev.start, ev.start + fade, ev.end - fade, ev.end], [0, 1, 1, 0], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : 1;
        return (
          <AbsoluteFill
            key={`${i}-${raw.start}`}
            style={{
              opacity,
              justifyContent: justify,
              alignItems: 'center',
              paddingLeft: width * 0.05,
              paddingRight: width * 0.05,
              paddingTop: preset.position === 'top' ? preset.margin_v : 0,
              paddingBottom: preset.position === 'bottom' ? preset.margin_v : 0,
            }}
          >
            <div
              style={{
                textAlign: 'center',
                fontFamily: `"${preset.font}", Arial, sans-serif`,
                fontSize: preset.font_size,
                fontWeight: preset.bold ? 900 : 400,
                lineHeight: 1.35,
                color: preset.primary_color,
                textTransform: preset.uppercase ? 'uppercase' : 'none',
                textShadow: outlineShadows(preset.outline_width, preset.outline_color),
              }}
            >
              {ev.lines.map((line, li) => (
                <div key={li}>
                  {line.map((w, wi) => {
                    const startFrame = Math.round(w.start * fps);
                    const localFrame = startFrame >= 0 ? frame - startFrame : -1;
                    const active = doKaraoke && t >= w.start && t < w.end;
                    const wordAnim = animations ? w.style?.animation ?? 'none' : 'none';
                    const a = animations ? wordAnimation(wordAnim as CaptionAnimation, localFrame, fps) : { opacity: 1, scale: 1, translateY: 0, translateX: 0 };
                    const emph = emphasis.enabled && w.emphasis;
                    const styledScale = w.style?.scale ?? 1;
                    // reserve constant inline space for the word's peak visual growth:
                    // a transform-scaled inline-block keeps its layout box, so without
                    // this the enlarged word paints over its neighbours' letters
                    const animPeak = wordAnim === 'pop' ? 1.3 : wordAnim === 'bounce' ? 1.35 : 1;
                    const rawPeak = Math.max(1, styledScale * animPeak * (emph ? emphasis.scale_percent / 100 : 1) * (isKinetic ? 1.12 : 1));
                    const estWidthEm = Math.min(9, Math.max(2, w.text.length * 0.68));
                    const reserveEm = Math.min(1, Math.max(0, (rawPeak - 1) * 0.5 * estWidthEm - 0.12));
                    const maxSafeScale = 1 + (2 * reserveEm) / estWidthEm;
                    let scale = a.scale * styledScale;
                    if (emph) scale *= emphasis.scale_percent / 100;
                    if (isKinetic && active) scale *= 1.12;
                    scale = Math.min(maxSafeScale, scale);
                    let color = w.style?.color ?? undefined;
                    if (!color && (w.style || emph)) color = emph ? emphasis.color : undefined;
                    if (active && !color) color = preset.karaoke_color;
                    const fontWeight = w.style?.fontWeight ?? (emph && emphasis.bold ? 900 : preset.bold ? 900 : undefined);
                    const dimmed = isKinetic && !active && !!w.style && t >= w.end;
                    return (
                      <span
                        key={wi}
                        style={{
                          display: 'inline-block',
                          transform: [
                            scale !== 1 ? `scale(${scale})` : '',
                            a.translateY ? `translateY(${a.translateY}px)` : '',
                            a.translateX ? `translateX(${a.translateX}px)` : '',
                          ].filter(Boolean).join(' ') || undefined,
                          marginRight: wi < line.length - 1 ? '0.27em' : 0,
                          paddingLeft: reserveEm ? `${reserveEm.toFixed(3)}em` : undefined,
                          paddingRight: reserveEm ? `${reserveEm.toFixed(3)}em` : undefined,
                          color: color ?? undefined,
                          fontWeight,
                          opacity: dimmed ? 0.75 : a.opacity,
                        }}
                      >
                        {w.text}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
