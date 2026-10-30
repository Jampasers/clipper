# Remotion Subtitle Overlay — Design

**Date:** 2026-10-30
**Status:** Approved (overlay architecture, per-word highlight animation)

## Goal

Replace the FFmpeg ASS subtitle burn-in with animated captions rendered by Remotion,
while keeping the rest of the render pipeline (reframe, encode, QA, Telegram) unchanged.

## Architecture

Remotion renders **only the caption layer**, on a transparent background, as a ProRes 4444
`.mov` overlay. FFmpeg composites it onto the cropped/scaled clip in the existing
single encode pass.

```
source --crop/fps/scale--+
                         +--overlay--> h264/aac mp4 --> QA (unchanged)
caption.mov (Remotion) --+
```

- New `remotion/` folder (self-contained React + TSX, bundled by `@remotion/bundler`):
  - `remotion/word-state.ts` — pure layout/timing logic (unit-testable, no React).
  - `remotion/CaptionOverlay.tsx` — transparent composition: one event block at a time,
    per-word karaoke highlight, emphasis styling, fade/typewriter animations.
  - `remotion/index.tsx` — `registerRoot` + `<Composition>`; width/height/fps/duration
    come from `inputProps` via `calculateMetadata` so one composition serves final and
    preview renders.
- New `src/services/caption-render.ts`: bundles the Remotion project once (cached),
  `ensureBrowser()` (auto-downloads Chrome Headless Shell ~200 MB on first use), then
  `renderMedia()` (codec `prores`, profile `4444`, `imageFormat: 'png'`,
  `pixelFormat: 'yuva444p10le'`) into `<temp>/<clipId>/caption.mov`.
- `src/services/render.ts`: when the Remotion engine is active, the caption `.mov` is
  added as a second ffmpeg input and the filter graph becomes
  `[0:v]<crop,fps,scale>[base];[base][1:v]overlay=0:0:format=auto[v]` with
  `-map [v]` and `-map 0:a?`. The overlay file is deleted after a successful render.
- SRT/ASS files are still generated (download links, QA check) — they are just no
  longer the burn-in source when `engine = 'remotion'`.

### Escape hatch

New setting `subtitles.engine: 'remotion' | 'ass'` (default `remotion`). `ass` keeps the
old `subtitles=sub.ass` filter path, so the previous behavior remains available without
code changes.

## Caption behavior

- Preset mapping: `font`, `font_size` (px at output resolution, same semantics as the
  ASS `PlayRes` style), `primary_color`, `outline_color` + `outline_width` (multi-direction
  text-shadow), `position` + `margin_v`, `bold`, `uppercase`, line wrapping from the
  existing `wrapText`.
- `animation: 'fade'` — event block fades in/out (0.35 s, capped at ⅓ of event length,
  matching the current ASS `\fad`).
- `animation: 'typewriter'` — each word appears at its word start time. Without word
  timings, words are distributed evenly across the event.
- `karaoke` preset flag or `typewriter` animation — active word uses `karaoke_color`
  and a small 1.06 scale pop.
- Emphasis words (AI-selected) override with `emphasis.color` / `scale_percent` / `bold`.
- Word timing comes from existing `SubtitleEvent.words` (clip-relative seconds).

## Render pipeline changes

- `renderClip`: keep event building + `writeSubtitleFiles`; when engine is `remotion`,
  render the overlay first (progress 35→45), then encode with the overlay input.
- `buildFfmpegArgs` gains an optional `overlayPath`; without it, behavior is byte-identical
  to today (`-vf`).
- QA, preview sizing, reframe plans, Telegram delivery: untouched.

## Dependencies

`remotion`, `@remotion/bundler`, `@remotion/renderer`, `react`, `react-dom`
(dev: `@remotion/cli`, `@types/react`, `@types/react-dom`).
`remotion/` is excluded from the server `tsc` build (Remotion bundles it itself);
`word-state.ts` is plain TS and is typechecked via its unit-test import.

## Testing / verification

- Unit: `layoutEvent` word-timing/emphasis assignment (incl. synthesized typewriter
  timing); `buildFfmpegArgs` overlay form (second `-i`, `filter_complex` overlay,
  `-map [v]`).
- E2E suite pins `subtitles.engine = 'ass'` to stay fast/deterministic (no Chrome
  download in CI); the Remotion path is verified once manually through the normal
  e2e render tests before pinning, plus Remotion Studio for visual tuning.
- Docs: `docs/configuration.md` (engine key), README (stack + pipeline wording).

## Non-goals (deliberate)

- No full-video Remotion rendering (video stays on FFmpeg).
- No spring entry transitions / per-line animation presets, no web-font loader,
  no caption composition registry.
