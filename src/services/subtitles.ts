import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { getSettings, type SubtitlePreset } from '../lib/settings.js';
import type { TranscriptSegment } from './transcribe.js';
import { generate } from '../lib/ai.js';
import { logger } from '../lib/log.js';
import { clipSegmentsToTimeline, type TimelinePlan } from './timeline.js';
import type { WordStyle } from './subtitle-plan.js';

export interface SubtitleEvent {
  start: number; // clip-relative seconds
  end: number;
  lines: string[];
  words: { text: string; start: number; end: number; style?: WordStyle }[] | null; // clip-relative word timing
  emphasisWords: string[];
}

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '');
}

function hexToAss(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '#FFFFFF');
  const rgb = m ? m[1].toUpperCase() : 'FFFFFF';
  return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const r = cs % 100;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(r)}`;
}

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

export function wrapText(text: string, maxChars: number, maxWords: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const w of words) {
    if (cur.length >= maxWords || (cur.length > 0 && curLen + w.length + 1 > maxChars)) {
      lines.push(cur.join(' '));
      cur = [];
      curLen = 0;
    }
    cur.push(w);
    curLen += w.length + 1;
  }
  if (cur.length) lines.push(cur.join(' '));
  if (lines.length > maxLines) return lines.slice(0, maxLines);
  return lines;
}

export function buildSubtitleEvents(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  preset: SubtitlePreset
): SubtitleEvent[] {
  const events: SubtitleEvent[] = [];
  for (const seg of segments) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    const s = Math.max(0, seg.start - clipStart);
    const e = Math.min(clipEnd - clipStart, seg.end - clipStart);
    if (e - s < 0.15) continue;
    const text = preset.uppercase ? seg.text.toUpperCase() : seg.text;
    const lines = wrapText(text, preset.max_chars_per_line, preset.max_words_per_line, preset.max_lines);
    const words = seg.words && seg.words.length
      ? seg.words
          .filter((w) => w.end > clipStart && w.start < clipEnd)
          .map((w) => ({
            text: preset.uppercase ? w.word.toUpperCase() : w.word,
            start: Math.max(0, w.start - clipStart),
            end: Math.min(e, w.end - clipStart),
          }))
      : null;
    events.push({ start: s, end: e, lines, words, emphasisWords: [] });
  }
  return events;
}

/** Attach per-clip emphasis words chosen by the caller (AI or manual). */
export function withEmphasis(events: SubtitleEvent[], words: string[]): SubtitleEvent[] {
  const targets = new Set(words.map(norm));
  for (const ev of events) {
    const found: string[] = [];
    for (const line of ev.lines) {
      for (const raw of line.split(/\s+/)) {
        if (targets.has(norm(raw)) && !found.some((f) => norm(f) === norm(raw))) found.push(raw);
      }
    }
    ev.emphasisWords = found;
  }
  return events;
}

/**
 * Subtitle events over a (possibly hook-reordered) output timeline. Segments are
 * clipped per timeline segment, shifted to output time, and never overlap.
 */
export function buildTimelineSubtitleEvents(
  segments: TranscriptSegment[],
  timeline: TimelinePlan,
  preset: SubtitlePreset
): SubtitleEvent[] {
  const events: SubtitleEvent[] = [];
  for (const { seg, outStart, outEnd, oStart, oEnd } of clipSegmentsToTimeline(segments, timeline)) {
    if (outEnd - outStart < 0.15) continue;
    let text = seg.text;
    let words: SubtitleEvent['words'] = null;
    if (seg.words && seg.words.length) {
      const clipped = seg.words.filter((w) => w.end > oStart && w.start < oEnd);
      if (clipped.length) {
        const partial = clipped.length < seg.words.length;
        if (partial) text = clipped.map((w) => w.word).join(' ');
        const segDuration = Math.max(0.01, oEnd - oStart);
        words = clipped.map((w) => ({
          text: preset.uppercase ? w.word.toUpperCase() : w.word,
          start: outStart + Math.max(0, w.start - oStart),
          end: Math.min(outEnd, outStart + Math.min(segDuration, w.end - oStart)),
          style: w.style,
        }))
          .filter((w) => w.end > w.start)
          .map((w) => ({ ...w, end: Math.min(outEnd, w.end) }));
      }
    }
    const display = preset.uppercase ? text.toUpperCase() : text;
    const lines = wrapText(display, preset.max_chars_per_line, preset.max_words_per_line, preset.max_lines);
    const emphasisWords = [...new Set((words ?? []).filter((w) => w.style).map((w) => w.text))].slice(0, 12);
    events.push({ start: outStart, end: outEnd, lines, words, emphasisWords });
  }
  events.sort((a, b) => a.start - b.start);
  // a cut point can truncate an event: shrink the earlier one so events never overlap
  for (let i = 1; i < events.length; i++) {
    if (events[i].start < events[i - 1].end) events[i - 1].end = events[i].start;
  }
  return events.filter((e) => e.end - e.start >= 0.12);
}

export function eventsToSrt(events: SubtitleEvent[]): string {
  return events.map((ev, i) => `${i + 1}\n${srtTime(ev.start)} --> ${srtTime(ev.end)}\n${ev.lines.join('\n')}`).join('\n\n');
}

/** Render one line of dialogue text with karaoke/emphasis tags. */
function renderLine(line: string, ev: SubtitleEvent, preset: SubtitlePreset): string {
  const sub = getSettings('subtitles');
  const em = sub.emphasis;
  const emphasisSet = new Set(ev.emphasisWords.map(norm));
  const doKaraoke = preset.karaoke || preset.animation === 'typewriter';
  const rawWords = line.split(/\s+/).filter(Boolean);
  if (!doKaraoke && !(em.enabled && ev.emphasisWords.length)) return line;

  const out: string[] = [];
  for (const rw of rawWords) {
    const word = ev.words?.find((x) => norm(x.text) === norm(rw));
    let tags = '';
    if (doKaraoke && word) {
      const decs = Math.max(1, Math.round((word.end - word.start) * 10));
      tags += `{\\k${decs}}`;
    }
    const isEmph = em.enabled && emphasisSet.has(norm(rw));
    if (isEmph) {
      tags += `{\\b${em.bold ? 1 : 0}\\fs${Math.round(preset.font_size * (em.scale_percent / 100))}\\c${hexToAss(em.color)}}${rw}{\\b${preset.bold ? 1 : 0}\\fs${preset.font_size}\\c${hexToAss(preset.primary_color)}}`;
    } else {
      tags += rw;
    }
    out.push(tags);
  }
  return out.join(' ');
}

export function eventsToAss(events: SubtitleEvent[], preset: SubtitlePreset, playResX: number, playResY: number): string {
  const align = preset.position === 'top' ? 8 : preset.position === 'middle' ? 5 : 2;
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${preset.font},${preset.font_size},${hexToAss(preset.primary_color)},${hexToAss(preset.karaoke_color)},${hexToAss(preset.outline_color)},&H80000000,${preset.bold ? -1 : 0},0,0,0,100,100,0,0,1,${preset.outline_width},${Math.max(1, Math.round(preset.outline_width / 2))},${align},10,10,${preset.margin_v},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const dialogues = events.map((ev) => {
    const evLen = Math.max(0.3, ev.end - ev.start);
    const pre =
      preset.animation === 'fade'
        ? `{\\fad(${Math.round(Math.min(0.35, evLen / 3) * 1000)},${Math.round(Math.min(0.35, evLen / 3) * 1000)})}`
        : '';
    const text = ev.lines.map((l) => renderLine(l, ev, preset)).join('\\N');
    return `Dialogue: 0,${assTime(ev.start)},${assTime(ev.end)},Default,,0,0,0,,${pre}${text}`;
  });
  return header + '\n' + dialogues.join('\n') + '\n';
}

export function subtitleDir(clipId: string): string {
  const d = path.join(config.dirs.temp, clipId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function writeSubtitleFiles(
  clipId: string,
  events: SubtitleEvent[],
  presetName: string,
  res: { w: number; h: number }
): { srt: string; ass: string; preset: SubtitlePreset } {
  const sub = getSettings('subtitles');
  const preset = sub.presets[presetName] ?? sub.presets.podcast ?? Object.values(sub.presets)[0];
  const dir = subtitleDir(clipId);
  const srt = path.join(dir, 'sub.srt');
  const ass = path.join(dir, 'sub.ass');
  fs.writeFileSync(srt, eventsToSrt(events), 'utf8');
  fs.writeFileSync(ass, eventsToAss(events, preset, res.w, res.h), 'utf8');
  return { srt, ass, preset };
}

/** Ask AI which words deserve emphasis for this clip (graceful fallback: none). */
export async function aiEmphasisWords(transcript: TranscriptSegment[], start: number, end: number): Promise<string[]> {
  try {
    const excerpt = transcript
      .filter((s) => s.end > start && s.start < end)
      .map((s) => s.text)
      .join(' ')
      .slice(0, 6000);
    const { json } = await generate<{ emphasis?: string[] }>('subtitle_analysis', { transcript: excerpt });
    const arr = Array.isArray(json?.emphasis) ? json.emphasis.map(String) : [];
    return arr.slice(0, 12).filter((w) => w.trim().length > 0 && w.trim().length < 40);
  } catch (err: any) {
    logger.warn('AI', `emphasis words failed: ${String(err?.message).slice(0, 150)}`);
    return [];
  }
}
