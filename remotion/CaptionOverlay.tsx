/* Transparent caption overlay; FFmpeg composites this over the cropped video. */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { layoutEvent, type CaptionEvent } from './word-state';

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
}

function outlineShadows(w: number, color: string): string {
  if (w <= 0) return 'none';
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  return dirs.map(([x, y]) => `${x * w}px ${y * w}px 0 ${color}, ${x * w}px ${y * w}px ${w}px ${color}`).join(', ');
}

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({ events, preset, emphasis }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;
  const doKaraoke = preset.karaoke || preset.animation === 'typewriter';
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
                lineHeight: 1.25,
                color: preset.primary_color,
                textTransform: preset.uppercase ? 'uppercase' : 'none',
                textShadow: outlineShadows(preset.outline_width, preset.outline_color),
              }}
            >
              {ev.lines.map((line, li) => (
                <div key={li}>
                  {line.map((w, wi) => {
                    const active = doKaraoke && t >= w.start && t < w.end;
                    const emph = emphasis.enabled && w.emphasis;
                    const pop = active ? 1.06 : 1;
                    return (
                      <span
                        key={wi}
                        style={{
                          display: 'inline-block',
                          transform: pop !== 1 ? `scale(${pop})` : undefined,
                          marginRight: wi < line.length - 1 ? '0.27em' : 0,
                          color: emph ? emphasis.color : active ? preset.karaoke_color : undefined,
                          fontWeight: emph && emphasis.bold ? 900 : undefined,
                          fontSize: emph ? `${emphasis.scale_percent / 100}em` : undefined,
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
