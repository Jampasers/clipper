/* Adaptive creative overlay: AI titles, lower thirds, stat cards, callouts, a
 * progress bar and the existing hand-styled captions — one transparent ProRes
 * layer composited by FFmpeg. All times come from the validated EDL (output
 * timeline seconds). */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { CaptionOverlay, type CaptionEmphasis, type CaptionPreset } from './CaptionOverlay';
import type { CaptionEvent } from './word-state';
import type { Callout, LowerThird, StatCard, TitleCard } from '../src/services/edl.js';

export interface CreativeCaptions {
  events: CaptionEvent[];
  preset: CaptionPreset;
  emphasis: CaptionEmphasis;
  mode?: string;
  animations?: boolean;
}

export interface CreativeGraphics {
  accentColor: string;
  progressBar: boolean;
  titles: TitleCard[];
  lowerThirds: LowerThird[];
  statCards: StatCard[];
  callouts: Callout[];
}

export interface CreativeOverlayProps {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  captions: CreativeCaptions | null;
  graphics: CreativeGraphics | null;
}

interface Timing {
  opacity: number;
  enter: number;
}

function timing(t: number, start: number, end: number): Timing | null {
  if (t < start || t >= end) return null;
  const dur = Math.max(0.3, end - start);
  const fade = Math.min(0.3, dur / 4);
  return {
    opacity: interpolate(t, [start, start + fade, end - fade, end], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
    enter: interpolate(t, [start, start + fade], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  };
}

const FONT = '"Arial Black", Arial, sans-serif';
const shadow = '0 2px 10px rgba(0,0,0,0.65), 0 0 2px rgba(0,0,0,0.9)';
const bandJustify = (position: 'top' | 'center' | 'bottom') =>
  position === 'top' ? 'flex-start' : position === 'bottom' ? 'flex-end' : 'center';
const bandPad = (position: 'top' | 'center' | 'bottom', h: number) =>
  position === 'top' ? h * 0.08 : position === 'bottom' ? h * 0.2 : 0;

export const CreativeOverlay: React.FC<CreativeOverlayProps> = ({ captions, graphics }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const duration = durationInFrames / fps;
  const accent = graphics?.accentColor ?? '#FFD400';

  return (
    <AbsoluteFill>
      {captions ? <CaptionOverlay {...captions} /> : null}

      {graphics?.titles.map((card, i) => {
        const a = timing(t, card.start, card.end);
        if (!a) return null;
        return (
          <AbsoluteFill
            key={`t${i}`}
            style={{
              opacity: a.opacity,
              justifyContent: bandJustify(card.position),
              alignItems: 'center',
              paddingTop: bandPad(card.position, height),
              paddingBottom: card.position === 'bottom' ? bandPad('bottom', height) : 0,
              paddingLeft: width * 0.08,
              paddingRight: width * 0.08,
            }}
          >
            <div style={{ transform: `translateY(${a.enter}px)`, textAlign: 'center' }}>
              <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: height * 0.045, color: '#FFFFFF', textShadow: shadow, lineHeight: 1.15 }}>
                {card.text}
              </div>
              {card.sub ? (
                <div style={{ fontFamily: 'Arial, sans-serif', fontSize: height * 0.02, color: '#FFFFFF', opacity: 0.92, marginTop: height * 0.008, textShadow: shadow }}>
                  {card.sub}
                </div>
              ) : null}
              <div style={{ width: width * 0.16, height: 6, background: accent, margin: `${height * 0.014}px auto 0`, borderRadius: 3 }} />
            </div>
          </AbsoluteFill>
        );
      })}

      {graphics?.statCards.map((card, i) => {
        const a = timing(t, card.start, card.end);
        if (!a) return null;
        return (
          <AbsoluteFill
            key={`s${i}`}
            style={{
              opacity: a.opacity,
              justifyContent: bandJustify(card.position),
              alignItems: 'center',
              paddingTop: bandPad(card.position, height),
              paddingBottom: card.position === 'bottom' ? bandPad('bottom', height) : 0,
            }}
          >
            <div
              style={{
                transform: `translateY(${a.enter}px) scale(${interpolate(a.enter, [0, 12], [1, 0.94])})`,
                background: 'rgba(12,12,14,0.82)',
                borderRadius: 18,
                padding: `${height * 0.016}px ${width * 0.06}px`,
                border: `2px solid ${accent}`,
                textAlign: 'center',
              }}
            >
              <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: height * 0.052, color: accent, lineHeight: 1.05 }}>{card.value}</div>
              <div style={{ fontFamily: 'Arial, sans-serif', fontSize: height * 0.018, color: '#FFFFFF', marginTop: height * 0.004 }}>{card.label}</div>
            </div>
          </AbsoluteFill>
        );
      })}

      {graphics?.lowerThirds.map((lt, i) => {
        const a = timing(t, lt.start, lt.end);
        if (!a) return null;
        return (
          <AbsoluteFill
            key={`l${i}`}
            style={{
              opacity: a.opacity,
              justifyContent: 'flex-end',
              alignItems: 'flex-start',
              paddingBottom: height * 0.14,
              paddingLeft: width * 0.05,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'stretch', transform: `translateX(${-a.enter}px)` }}>
              <div style={{ width: 8, background: accent, borderRadius: 4 }} />
              <div style={{ background: 'rgba(12,12,14,0.82)', padding: `${height * 0.01}px ${width * 0.035}px`, borderRadius: '0 10px 10px 0' }}>
                <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: height * 0.028, color: '#FFFFFF', textShadow: shadow }}>{lt.name}</div>
                {lt.role ? <div style={{ fontFamily: 'Arial, sans-serif', fontSize: height * 0.016, color: accent, marginTop: 2 }}>{lt.role}</div> : null}
              </div>
            </div>
          </AbsoluteFill>
        );
      })}

      {graphics?.callouts.map((c, i) => {
        const a = timing(t, c.start, c.end);
        if (!a) return null;
        const px = c.x * width;
        const py = c.y * height;
        return (
          <AbsoluteFill key={`c${i}`} style={{ opacity: a.opacity }}>
            {c.pointer !== 'none' ? (
              <div
                style={{
                  position: 'absolute',
                  left: px - (c.pointer === 'circle' ? height * 0.04 : 0),
                  top: py - (c.pointer === 'circle' ? height * 0.04 : 0),
                  width: c.pointer === 'circle' ? height * 0.08 : 0,
                  height: c.pointer === 'circle' ? height * 0.08 : 0,
                  border: c.pointer === 'circle' ? `4px solid ${accent}` : undefined,
                  borderRadius: '50%',
                }}
              />
            ) : null}
            <div
              style={{
                position: 'absolute',
                left: Math.min(width * 0.8, Math.max(width * 0.06, px - width * 0.22)),
                top: Math.min(height * 0.9, Math.max(height * 0.04, py - height * 0.12)),
                maxWidth: width * 0.44,
                background: 'rgba(12,12,14,0.85)',
                border: `2px solid ${accent}`,
                borderRadius: 10,
                padding: `${height * 0.008}px ${width * 0.025}px`,
                fontFamily: 'Arial, sans-serif',
                fontWeight: 700,
                fontSize: height * 0.018,
                color: '#FFFFFF',
                textShadow: shadow,
              }}
            >
              {c.text}
            </div>
          </AbsoluteFill>
        );
      })}

      {graphics?.progressBar ? (
        <div style={{ position: 'absolute', left: width * 0.05, bottom: height * 0.02, width: width * 0.9, height: 6, background: 'rgba(255,255,255,0.28)', borderRadius: 3 }}>
          <div style={{ width: `${Math.min(100, (t / Math.max(0.001, duration)) * 100)}%`, height: '100%', background: accent, borderRadius: 3 }} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
