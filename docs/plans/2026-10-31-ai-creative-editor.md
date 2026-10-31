# AI Creative Video Editor — Repository Audit & Implementation Plan

Date: 2026-10-31. Scope: upgrade Jampasers/clipper into an AI Creative Video Editor
with adaptive editing (EDL-driven), while keeping the existing pipeline, features
and contracts intact (`creativeMode: "basic"`).

## 1. Repository audit (Tahap 1)

### Verified stack

- TypeScript strict, NodeNext ESM, Node 22 (`node:sqlite` `DatabaseSync`), zod v3,
  Express 4, Remotion 4 + @remotion/bundler/renderer, `openai` SDK pointed at a
  9Router-compatible endpoint, faster-whisper + OpenCV Python sidecars.
- Baseline at audit time: `pnpm typecheck` OK, `pnpm test:unit` 55/55,
  `pnpm test:api` 14/14. Chrome Headless Shell already cached in
  `node_modules/.remotion` (Remotion overlay path works offline).
- FFmpeg 9.0 full build. Capability probes run live:
  - `scale` with `eval=frame` evaluating `t` per frame → OK (punch-in/out primitive).
  - `blackdetect`, `signalstats`+`metadata=print`, scene score via
    `select=gt(scene,X)`+`metadata=print` → OK (scene analysis + QA primitives).
  - `afftdn`, `boxblur`, `eq`, `colorbalance`, `vignette`, `xfade`, `amix`, `alimiter`,
    `loudnorm`, `sidechaincompress` available (audio engine needs no new deps).
- Input-level `-ss` resets filter-graph timestamps to 0 (verified with showinfo).
  The existing hook-segment pan therefore uses misaligned keyframe times for the
  hook input — a latent bug to fix while adding per-segment time offsets.

### Actual pipeline and contracts

```
upload (web/Telegram) -> probe -> transcription -> analysis -> candidate_generation
  -> scoring (score + boundary refine + dedup) -> READY (clips, top-N selected)
render job (preview | final | telegram):
  resolveRenderOptions (defaults -> preset -> request, zod) -> snapshot
  -> getOrCreateEditingPlan (cached per clip+options_hash): hook span (AI, word-index
     validated), output timeline (hook copied to front + crossfade overlap), subtitle
     styling plan (word roles; deterministic fallback), music selection (local library)
  -> renderClip: face-tracked reframe (track_faces.py, speech-gated) -> subtitle events
     on output timeline -> Remotion CaptionOverlay (ProRes 4444 transparent) or legacy
     ASS burn-in -> single FFmpeg pass (render-graph.ts): per-segment -ss/-t inputs,
     crop/fps, xfade/concat, scale, subtitles, caption overlay, watermarks; voice
     loudnorm + BGM loudnorm + speech-window volume ducking + fades + limiter
  -> QA: qualityCheck (structure/duration/resolution/sanity frame) + ebur128 loudness
     + true peak
```

- Data contracts between services are plain interfaces: `TranscriptData`,
  `EditingPlan` (`EditingPlan` = timeline + hook + subtitle + music + optionsHash),
  `RenderOptions` (zod `renderOptionsSchema`), `ReframePlan`, `TimelinePlan`,
  `RenderGraphSpec`.
- AI always returns JSON routed through `generate(task, vars)`; local validation only.
  The model can never produce shell/ffmpeg commands (`src/lib/tools.ts` whitelist;
  plan services validate with zod). This contract is kept and extended, not replaced.
- Telegram: long-poll `bot.ts`, commands `/start /help /projects /clips /render
  /health`, inline render + Tune menu (draft options per chat+clip in memory),
  progress via status polling, delivery via `sendVideo` (≤49 MB).
- Asset/temp management: storage/<dir> on disk + SQLite metadata; temp under
  `config.dirs.temp/<clipId>`; cleanup on success paths and best-effort on failure.
- Cancellation: `cancelJob` kills the registered ffmpeg child (jobId registry) and
  wins over retry; orphaned jobs requeued on boot.
- Concurrency: single in-process worker loop (one job at a time) + `pnpm worker`.

### Feature gap analysis vs the upgrade brief

| Brief item | Status in repo |
| --- | --- |
| Hook teaser, dynamic subtitles (roles/kinetic), BGM + ducking, watermarks, per-render options/presets/snapshots, editing-plan cache | **exists** (keep) |
| Creative Director / scene understanding / visual analysis | missing (only face tracking + transcript) |
| EDL schema + builder + validator + safe fallback | missing (EditingPlan is close but not a full EDL) |
| Punch-in/out, wide/medium/close framing | missing (only face-track pan + static crop) |
| Animated titles, lower-thirds, stat cards, callouts, progress bar | missing |
| Background blur, color grading, segment transitions (beyond hook crossfade) | missing |
| B-roll system (registry, context search, scoring, placement, fallback) | missing |
| SFX, voice cleanup (beyond loudnorm), audio fades at edges | missing / partial |
| Quality review (black frames, subtitle timing/safe area, face framing, overlay collision) + limited repair | partial (structure + loudness only) |
| `creativeMode` basic/adaptive switch, aspect + qualityReview parameters | partial (aspect exists; no mode switch) |
| Telegram adaptive controls (preview, cancel, URL ingest, default config) | partial |

## 2. Architecture (Tahap 2–7)

Design rules: additive only; AI output is always validated JSON (zod) compiled by
our own builders into FFmpeg/Remotion inputs — never commands; deterministic
fallbacks at every AI step; `basic` mode behavior preserved byte-for-byte.

### New modules

| Module | Role |
| --- | --- |
| `src/services/scene-analysis.ts` | Deterministic visual analysis per clip window: brightness (signalstats YAVG), scene cuts (scene score), black spans, face samples (reuses `track_faces.py`). Cached inside the editing plan. |
| `src/services/edl.ts` | **EDL schema (zod)** + timestamp normalization/clamping + semantic validation (windows, asset refs, caps) + collision-safe layout helpers + limited `repairEdl`. Style/titles/callouts/broll/sfx/framings are data. |
| `src/services/adaptive-style.ts` | Adaptive Style Engine: scene/transcript/aspect signals → style profile (grade, punch-in, bg fill, transition, edge fades, progress bar,.caption style). Deterministic; AI picks a style key but the profile is code. |
| `src/services/creative-director.ts` | Builds inputs (transcript+words, scene analysis, clip meta, asset catalog, options) → AI task `creative_direction` → zod EDL parse + validation → fallback deterministic EDL builder. Never throws. |
| `src/services/broll.ts` | B-roll registry (`broll_assets` table): upload validation (ffprobe), tags/license/source metadata, context-aware scoring (tag overlap with transcript keywords around the target window + duration/type fit), resolution to render specs, unresolved → dropped with warning. |
| `src/services/sfx.ts` | SFX library (`sound_effects` table) + resolution; same metadata model as music. |
| `src/services/quality-review.ts` | Static review (subtitle timing, safe area, overlay collision, b-roll validity) + media review (blackdetect, face framing vs crop box, loudness reuse) + `repairEdl` fixes. Max 1 repair + 1 re-render, then safe fallback. |
| `remotion/CreativeOverlay.tsx` | One transparent composition embedding the existing `CaptionOverlay` + animated title cards, lower-thirds, stat cards, callouts/pointers, progress bar. Deterministic frame-based animation; positions clamped to safe area. |

### New AI task (controlled)

`creative_direction` prompt added to `PROMPT_TASKS`/`DEFAULT_PROMPTS` + `AiTask`
union + default routing. The prompt receives bounded context and must answer only
a JSON EDL fragment; anything invalid is dropped and the deterministic fallback EDL
(full style engine) is used. No new model dependencies.

### Render flow (adaptive)

```
options.creativeMode = 'adaptive':
  scene analysis (ffmpeg, cached in plan) ─┐
  style engine (deterministic)             ├─> Creative Director -> EDL
  transcript + clip meta + assets ─────────┘        (zod-validated, fallback built-in)
  -> static quality review (+repair)
  -> Remotion CreativeOverlay (captions + graphics, ProRes 4444)
  -> render-graph v2: per-segment pan (time-offset fixed), punch-in/out (scale
     eval=frame + animated crop), color grade, background blur fill, b-roll video/
     image overlays (cover|pip, alpha fades), voice cleanup (highpass+afftdn),
     BGM + SFX mix (adelay/volume), crossfade transitions (fade|slide|cut), edge fades
  -> media quality review -> if fail: repair EDL -> re-render ONCE
     -> if still fail: safe fallback render (captions+grade+music only), flagged
```

`creativeMode = 'basic'`: identical to the audited flow (plan.edl = null; new graph
features all default-off; pan offset fix applies to both modes — it is a correctness fix).

### Integration points (kept contracts)

- `RenderOptions` gains `creativeMode`, `qualityReview` (+ style passthrough);
  schema stays strict zod; presets get adaptive variants; `planOptionsHash` extended.
- `EditingPlan` gains `edl`, `style`, `scene` (version bump → cache rebuild, no break).
- New tables via additive `CREATE TABLE IF NOT EXISTS` migrations: `broll_assets`,
  `sound_effects` (+ indexes). Scene analysis/lifecycle data persist inside
  `editing_plans.data` / `analyses` — no schema change needed there.
- New HTTP endpoints under existing routers (`/api/assets/broll`, `/api/assets/sfx`);
  Telegram Tune menu extended (mode/aspect/QA toggles, preview, cancel, URL ingest,
  `/config`).

## 3. Testing strategy

- Unit: EDL schema/normalizer/repair, style engine, scene parser (fixtures from
  real ffmpeg output), creative-director normalization (no network), broll scoring,
  render-graph builders (zoom expr, blur chain, broll/sfx indices, grade, cut/fade
  transitions), quality-review checks, basic-mode regression.
- Integration: real-FFmpeg adaptive smoke render on lavfi fixtures (zoom + grade +
  b-roll overlay + SFX + review), verifying pixels/timeline via ffprobe + extracted
  frames (signalstats channel means), not just exit codes. Remotion overlay smoke
  runs with the cached Chrome Headless Shell; skips gracefully without it.
- Suites: extend `test/editing.test.ts` + new `test/creative.test.ts`,
  `test/adapt-render.test.ts`, `test/quality.test.ts`; runner unchanged.

## 4. Deliverable map

1. Audit report — this doc §1. 2. Architecture — §2. 3. EDL schema — `src/services/edl.ts`.
4. Creative Director — `src/services/creative-director.ts`. 5. Style Engine —
`src/services/adaptive-style.ts`. 6. Visual engine — `render-graph.ts` +
`remotion/CreativeOverlay.tsx` + `caption-render.ts`. 7. B-roll — `broll.ts` + routes.
8. Audio engine — render-graph audio section + `sfx.ts`. 9. Quality reviewer —
`quality-review.ts`. 10. Pipeline — `pipeline.ts`/`render.ts`/`editing-plan.ts`.
11. Telegram — `bot.ts`. 12. Tests — as above. 13. Docs — `docs/creative-editor.md`
+ doc updates. 14–15. File summary + results in the final report.

## 5. Results (final report)

### Verification

- `pnpm typecheck` clean. `pnpm test` (single process, temp DB): **113 passed, 0 failed**
  — 89 unit, 15 api, 9 e2e incl. real-FFmpeg adaptive/b-roll/SFX renders and the
  Remotion overlay with the cached Chrome Headless Shell.
- Adaptive path proven end-to-end: AI creative plan → validated EDL → repaired
  graphics → single-pass FFmpeg → QA + media review, on both the live pipeline
  (e2e) and lavfi fixtures (integration, pixel-verified via signalstats).

### Files

- New: `src/services/{scene-analysis,edl,adaptive-style,creative-director,broll,sfx,quality-review}.ts`,
  `src/routes/assets.ts`, `remotion/CreativeOverlay.tsx`, `docs/creative-editor.md`.
- Changed: `src/services/{render,render-graph,editing-plan,caption-render,pipeline,render-options,assets}.ts`,
  `src/lib/{sqlite,log,settings,prompts}.ts`, `src/telegram/bot.ts`, `src/index.ts`,
  `public/app.js`, `README.md`, `docs/{configuration,telegram}.md`.
- Tests: new `test/creative.test.ts`, `test/render-integration.test.ts`; extended
  `test/{editing,api,e2e,unit}.test.ts`.

### Deviations & limitations

- **Media review scope**: `black_frames`/`audio_clipping` repairs only re-encode the
  FFmpeg graph (drop offending b-roll, disable edge fades, attenuate SFX/music), at
  most once; the Remotion overlay is never re-rendered. Unresolved issues are
  reported in `summary.qualityIssues` + `REVIEW` logs, never silently shipped.
- **AI is best-effort**: invalid/oversized fragments are dropped by validation;
  a failed director call falls back to the deterministic baseline EDL.
- **B-roll video windows** show the asset from its own start; the placement window
  is an `enable`-gated overlay on the main clock (no in-asset scrubbing).
- First Remotion overlay of a process pays a ~30–60 s Chrome cold start (timeouts
  120 s); subsequent renders are fast.
- Telegram: adaptive defaults + toggles only — preview-then-full render, cancel
  button and URL ingest remain later-phase items.
- Full-suite verification surfaced test-isolation issues fixed here: a 1-byte
  placeholder watermark PNG was resolvable by other suites (now a valid PNG), the
  b-roll unit fixtures are disabled after use, and the runner executes deferred
  async tests after all modules register, so unit tests must not assume an empty
  library table.
