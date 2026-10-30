# Remotion Subtitle Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the FFmpeg ASS subtitle burn-in with animated Remotion captions composited as a transparent overlay, with an `ass` engine escape hatch.

**Architecture:** Remotion renders only the caption layer (ProRes 4444 transparan `.mov`); FFmpeg overlays it in the existing single encode pass. Reframe/encode/QA/Telegram untouched; SRT/ASS still generated. Setting `subtitles.engine` switches back to the legacy burn-in.

**Tech Stack:** Remotion v4 (`remotion`, `@remotion/bundler`, `@remotion/renderer`, dev `@remotion/cli`), React 18, TSX, existing Express/TS server.

**Spec:** `docs/superpowers/specs/2026-10-30-remotion-subtitles-design.md`

**Note:** This directory is not a git repo — all commit steps are omitted; run `cmd /c "pnpm typecheck"` and `cmd /c "pnpm test:unit"` after each task instead.

---

### Task 1: Install Remotion + project wiring

**Files:**
- Modify: `package.json` (via pnpm)
- Modify: `tsconfig.json`

- [ ] **Step 1: Install deps** (Remotion CLI must run through `cmd /c` on Windows PowerShell 5.1)

```powershell
cmd /c "pnpm add remotion @remotion/bundler @remotion/renderer react react-dom"
cmd /c "pnpm add -D @remotion/cli @types/react @types/react-dom"
```

Expected: install succeeds; `remotion` + `@remotion/*` share the same `^4.x` version.

- [ ] **Step 2: Exclude the Remotion folder from the server TS build**

In `tsconfig.json`, change `"exclude"`:

```json
"exclude": ["node_modules", "dist", "remotion"]
```

(The Remotion project is bundled by Remotion's own webpack; `remotion/word-state.ts` still gets typechecked through its unit-test import.)

- [ ] **Step 3: Add a Studio script for visual tuning**

In `package.json` `scripts`, add:

```json
"studio": "remotion studio remotion/index.tsx",
```

- [ ] **Step 4: Verify server build still passes**

Run: `cmd /c "pnpm typecheck"`
Expected: PASS (no changes to src yet).

---

### Task 2: `word-state.ts` — pure layout/timing logic (TDD)

**Files:**
- Create: `remotion/word-state.ts`
- Modify: `test/unit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit.test.ts` after the `eventsToAss` test (imports go at the top with the others):

```ts
import { layoutEvent, type CaptionEvent } from '../remotion/word-state.js';
```

```ts
test('layoutEvent assigns word timing and emphasis to the wrapped words', () => {
  const ev: CaptionEvent = {
    start: 0.5, end: 2.5, lines: ['Hello there friend', 'wow'],
    words: [
      { text: 'Hello', start: 0.5, end: 0.9 },
      { text: 'there', start: 0.9, end: 1.3 },
      { text: 'friend', start: 1.3, end: 1.8 },
      { text: 'wow', start: 1.8, end: 2.3 },
    ],
    emphasisWords: ['FRIEND!'],
  };
  const laid = layoutEvent(ev, true);
  assertEquals(laid.lines[0][2].text, 'friend');
  assertEquals(laid.lines[0][2].emphasis, true);
  assertEquals(laid.lines[0][0].emphasis, false);
  assert(Math.abs(laid.lines[1][0].start - 1.8) < 1e-6, 'wow keeps its timing');
});
test('layoutEvent synthesizes even timing when word timings are missing', () => {
  const laid = layoutEvent({ start: 0, end: 2, lines: ['a b'], words: null, emphasisWords: [] }, false);
  assertEquals(laid.lines[0].length, 2);
  assertEquals(laid.lines[0][0].start, 0);
  assertEquals(laid.lines[0][1].start, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cmd /c "pnpm test:unit"`
Expected: FAIL (cannot resolve `../remotion/word-state.js`).

- [ ] **Step 3: Write `remotion/word-state.ts`**

```ts
/* Pure caption layout/timing logic, shared by the Remotion composition and unit tests. */

export interface CaptionWord { text: string; start: number; end: number }

/** Structural twin of SubtitleEvent from src/services/subtitles.ts — kept local so
 *  the Remotion bundle never imports server code. */
export interface CaptionEvent {
  start: number;
  end: number;
  lines: string[];
  words: CaptionWord[] | null;
  emphasisWords: string[];
}

export interface LaidWord { text: string; start: number; end: number; emphasis: boolean }
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
  const i = byText >= 0 ? byText : timings.findIndex((_, i) => !used.has(i));
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
          return { text, start: w.start, end: w.end, emphasis: emphasisOn && targets.has(norm(text)) };
        })
    ),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cmd /c "pnpm test:unit"`
Expected: PASS (new tests green, all old tests still green).

---

### Task 3: Remotion composition

**Files:**
- Create: `remotion/CaptionOverlay.tsx`
- Create: `remotion/index.tsx`

- [ ] **Step 1: Write `remotion/CaptionOverlay.tsx`**

```tsx
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
```

- [ ] **Step 2: Write `remotion/index.tsx`**

```tsx
/* Remotion entry: registers the transparent CaptionOverlay composition.
   Width/height/fps/duration come from inputProps via calculateMetadata so the
   same composition serves final (1080x1920) and preview (540x960) renders. */
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { CaptionOverlay, type CaptionOverlayProps } from './CaptionOverlay';

const demoProps: CaptionOverlayProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 90,
  events: [
    {
      start: 0.5,
      end: 2.5,
      lines: ['This is what our', 'remotion captions look like'],
      words: null,
      emphasisWords: ['remotion'],
    },
  ],
  preset: {
    font: 'Arial Black', font_size: 64, position: 'bottom', margin_v: 220,
    primary_color: '#FFFFFF', outline_color: '#000000', outline_width: 4,
    bold: true, uppercase: false, karaoke: true, karaoke_color: '#FF3D00', animation: 'none',
  },
  emphasis: { enabled: true, color: '#FFD400', scale_percent: 118, bold: true },
};

const RemotionRoot: React.FC = () => (
  <Composition
    id="CaptionOverlay"
    component={CaptionOverlay}
    durationInFrames={demoProps.durationInFrames}
    fps={demoProps.fps}
    width={demoProps.width}
    height={demoProps.height}
    defaultProps={demoProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.durationInFrames,
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);

registerRoot(RemotionRoot);
```

- [ ] **Step 3: Visual check via Studio**

Run: `cmd /c "pnpm studio"`
Expected: Studio opens in a browser; "CaptionOverlay" plays the demo caption with karaoke highlight on "remotion". Close Studio after checking.

- [ ] **Step 4: Typecheck**

Run: `cmd /c "pnpm typecheck"`
Expected: PASS (`remotion/` excluded from server program).

---

### Task 4: `caption-render.ts` — overlay renderer service

**Files:**
- Create: `src/services/caption-render.ts`

- [ ] **Step 1: Write the service**

```ts
/* Renders the transparent caption overlay for one clip via Remotion (headless Chrome -> ProRes 4444). */
import path from 'node:path';
import fs from 'node:fs';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, getCompositions, renderMedia } from '@remotion/renderer';
import { config, ROOT } from '../config.js';
import type { SubtitlePreset } from '../lib/settings.js';
import type { SubtitleEvent } from './subtitles.js';
import { logger } from '../lib/log.js';

export interface CaptionRenderOpts {
  clipId: string;
  events: SubtitleEvent[];
  preset: SubtitlePreset;
  emphasis: { enabled: boolean; color: string; scale_percent: number; bold: boolean };
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

let bundleCache: Promise<string> | null = null;

async function bundleUrl(): Promise<string> {
  if (!bundleCache) {
    bundleCache = bundle({ entryPoint: path.join(ROOT, 'remotion', 'index.tsx') }).catch((err) => {
      bundleCache = null; // allow a retry on the next render
      throw err;
    });
  }
  return bundleCache;
}

export async function renderCaptionOverlay(o: CaptionRenderOpts): Promise<string> {
  const dir = path.join(config.dirs.temp, o.clipId);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'caption.mov');
  const inputProps = {
    width: o.width,
    height: o.height,
    fps: o.fps,
    durationInFrames: Math.max(1, Math.ceil(o.durationSec * o.fps)),
    events: o.events,
    preset: o.preset,
    emphasis: o.emphasis,
  };
  await ensureBrowser(); // downloads Chrome Headless Shell on first use
  const serveUrl = await bundleUrl();
  const comps = await getCompositions(serveUrl, { inputProps });
  const comp = comps.find((c) => c.id === 'CaptionOverlay');
  if (!comp) throw new Error('CaptionOverlay composition not found');
  await renderMedia({
    composition: comp,
    serveUrl,
    codec: 'prores',
    proResProfile: '4444',
    imageFormat: 'png',
    pixelFormat: 'yuva444p10le',
    outputLocation: out,
    inputProps,
  });
  logger.info('CAPTION', `overlay ready: ${o.clipId}/caption.mov (${o.events.length} events, ${o.width}x${o.height})`);
  return out;
}
```

- [ ] **Step 2: Typecheck**

Run: `cmd /c "pnpm typecheck"`
Expected: PASS (React/download deps resolve; `skipLibCheck: true` keeps Remotion d.ts quiet).

---

### Task 5: Engine setting + render.ts wiring (TDD on `buildFfmpegArgs`)

**Files:**
- Modify: `src/lib/settings.ts` (interface + defaults)
- Modify: `src/services/render.ts`
- Modify: `test/unit.test.ts`
- Modify: `test/e2e.test.ts` (pin `engine: 'ass'`)

- [ ] **Step 1: Write the failing test for the overlay ffmpeg args**

Append to `test/unit.test.ts` after the existing `buildFfmpegArgs` test:

```ts
test('buildFfmpegArgs composites the caption overlay instead of burning ass', () => {
  const rs = getSettings('render');
  const args = buildFfmpegArgs({
    source: 'in.mp4', start: 10, duration: 30,
    filters: 'fps=30,scale=1080:1920,setsar=1',
    overlayPath: 'C:/t/caption.mov', rs, hasAudio: true, output: 'out.mp4',
  });
  const s = args.join(' ');
  assert(args.includes('C:/t/caption.mov'), 'overlay is the second input');
  assert(s.includes('overlay=0:0:format=auto'), 'overlay filter present');
  assert(s.includes('-map [v]'), 'filtered video mapped');
  assert(!args.includes('-vf'), 'no single-input vf when overlaying');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cmd /c "pnpm test:unit"`
Expected: FAIL (TS error: `overlayPath` does not exist — tsc via tsx will still run, test fails on `-vf` presence).

- [ ] **Step 3: Add the engine setting**

In `src/lib/settings.ts`:

```ts
export interface SubtitleSettings {
  enabled: boolean;
  preset: string;
  /** 'remotion' = animated caption overlay; 'ass' = legacy ffmpeg burn-in */
  engine: 'remotion' | 'ass';
  presets: Record<string, SubtitlePreset>;
  emphasis: {
    enabled: boolean;
    color: string;
    scale_percent: number;
    bold: boolean;
  };
}
```

And in `DEFAULT_SETTINGS.subtitles`:

```ts
subtitles: {
  enabled: true,
  preset: 'bold',
  engine: 'remotion',
  emphasis: { enabled: true, color: '#FFD400', scale_percent: 112, bold: true },
```

(Deep-merge means existing DB rows pick up `engine: 'remotion'` automatically.)

- [ ] **Step 4: Rework `buildFfmpegArgs` in `src/services/render.ts`**

Replace the whole function with:

```ts
export function buildFfmpegArgs(opts: {
  source: string;
  start: number;
  duration: number;
  filters: string;
  overlayPath?: string | null;
  rs: RenderSettings;
  hasAudio: boolean;
  output: string;
}): string[] {
  const rs = opts.rs;
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats',
    '-ss', opts.start.toFixed(3), '-i', opts.source,
  ];
  if (opts.overlayPath) args.push('-i', opts.overlayPath);
  args.push('-t', opts.duration.toFixed(3));
  if (opts.overlayPath) {
    args.push(
      '-filter_complex', `[0:v]${opts.filters}[base];[base][1:v]overlay=0:0:format=auto[v]`,
      '-map', '[v]',
    );
    if (opts.hasAudio) args.push('-map', '0:a?');
  } else {
    args.push('-vf', opts.filters);
  }
  args.push('-c:v', rs.vcodec);
  if (rs.bitrate) args.push('-b:v', rs.bitrate);
  else args.push('-crf', String(rs.crf));
  if (opts.hasAudio) args.push('-c:a', rs.acodec, '-b:a', rs.audio_bitrate);
  else args.push('-an');
  args.push('-preset', rs.preset, '-pix_fmt', rs.pixel_format, '-movflags', '+faststart');
  args.push(opts.output);
  return args;
}
```

- [ ] **Step 5: Wire the overlay into `renderClip` in `src/services/render.ts`**

1) Add the overlay local in step 2 and render it when the engine is `remotion`:

```ts
  // 2. subtitles
  let files: { srt: string; ass: string; preset: SubtitlePreset } | null = null;
  let overlayPath: string | null = null;
```

and at the end of the `if (sub.enabled && ...)` block (after `writeSubtitleFiles`):

```ts
    if ((sub.engine ?? 'remotion') === 'remotion') {
      const { renderCaptionOverlay } = await import('./caption-render.js');
      overlayPath = await renderCaptionOverlay({
        clipId: clip.id, events, preset: files.preset, emphasis: sub.emphasis,
        width: size.w, height: size.h, fps: rs.fps, durationSec: clip.end - clip.start,
      });
      req.onProgress?.(45);
    }
```

2) Encode step: choose the burn source and pass the overlay:

```ts
  const filters = buildFilters(plan, size, rs.fps, overlayPath ? null : (files?.ass ?? null));
  const args = buildFfmpegArgs({
    source: req.sourcePath,
    start: clip.start,
    duration: clip.end - clip.start,
    filters,
    overlayPath,
    rs,
    hasAudio: req.probe.hasAudio,
    output: tmpOut,
  });
```

and bump the encode progress base from 35 to 45:

```ts
        req.onProgress?.(Math.min(95, 45 + Math.round((t / total) * 50)));
```

3) After the successful rename, delete the multi-GB overlay:

```ts
  fs.renameSync(tmpOut, output);
  if (overlayPath) try { fs.rmSync(overlayPath, { force: true }); } catch {}
```

- [ ] **Step 6: Pin the e2e suite to the fast legacy engine**

In `test/e2e.test.ts`, right after the `setSettings('clipping', {...})` block (line ~50), add:

```ts
  // keep e2e fast + deterministic: no Chrome download in the suite
  setSettings('subtitles', { engine: 'ass' });
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cmd /c "pnpm test:unit"` then `cmd /c "pnpm typecheck"`
Expected: PASS (both buildFfmpegArgs tests green; old tests unchanged).

---

### Task 6: Verify the real Remotion path end-to-end (once, manually)

**Files:** none (verification only)

- [ ] **Step 1: Run the e2e render against the remotion engine**

Temporarily comment out the `setSettings('subtitles', { engine: 'ass' })` line from Task 6 step 6 (fresh test DB ⇒ default `remotion`), then:

Run: `cmd /c "pnpm test:e2e"`
Expected: first run downloads Chrome Headless Shell (~200 MB), then the render tests pass with captions composited; `caption.mov` was created and cleaned up under `storage/temp/<clipId>/`. Preview MP4 visually contains animated captions when inspected.

- [ ] **Step 2: Restore the pin**

Uncomment/restore `setSettings('subtitles', { engine: 'ass' });` in `test/e2e.test.ts`.

Run: `cmd /c "pnpm test:e2e"`
Expected: PASS quickly without Chrome download.

---

### Task 7: Dashboard setting + docs

**Files:**
- Modify: `public/app.js` (subtitles settings page)
- Modify: `docs/configuration.md`
- Modify: `README.md`

- [ ] **Step 1: Add the engine select to the Global card**

In `public/app.js` `settingsSubtitles()` (after the `Default preset` select, ~line 773), insert:

```js
      <label>Render engine</label>
      <select id="engine">
        <option value="remotion" ${s.engine !== 'ass' ? 'selected' : ''}>remotion — animated captions</option>
        <option value="ass" ${s.engine === 'ass' ? 'selected' : ''}>ass — ffmpeg burn-in (legacy)</option>
      </select>
```

and add `engine: $('#engine').value,` to the `saveGlobal` body object (~line 832).

- [ ] **Step 2: Update `docs/configuration.md`**

In the subtitles section (near line 64), add to the bullet list:

```markdown
- `subtitles.engine` = `remotion` (default) renders animated captions (per-word karaoke
  highlight, fade/typewriter) as a transparent overlay composited by FFmpeg; `ass` is the
  legacy FFmpeg `subtitles=` burn-in. First `remotion` render downloads Chrome Headless
  Shell once (~200 MB).
- Presets `classic | bold | minimal | karaoke | podcast`, each with `font`, `font_size`,
```

(keep the existing presets bullet below it)

- [ ] **Step 3: Update `README.md`**

Line 18-19: change "ASS/SRT subtitles with emphasis" to
"animated caption overlays via Remotion (SRT/ASS still exported)". Stack line (~85): add
"Remotion (caption overlay)" after "FFmpeg + faster-whisper + OpenCV sidecars".

- [ ] **Step 4: Full verification**

Run: `cmd /c "pnpm typecheck"` then `cmd /c "pnpm build"` then `cmd /c "pnpm test:unit"`
Expected: all PASS.

---

## Self-review notes

- Spec coverage: engine setting (Task 5), overlay renderer (Task 4), composition + animation behavior (Tasks 2-3), ffmpeg composition path (Task 5), UI (Task 7), docs (Task 7), escape hatch (Tasks 5-6). SRT/ASS generation stays (no change needed — `writeSubtitleFiles` untouched).
- Type consistency: `CaptionEvent` structurally mirrors `SubtitleEvent`; `files.preset` replaces a second `resolvePreset` call; `layoutEvent`/`renderCaptionOverlay`/`buildFfmpegArgs(overlayPath)` signatures match across tasks.
- No placeholders; every code step contains the final code.
