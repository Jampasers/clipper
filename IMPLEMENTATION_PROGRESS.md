# Implementation Progress — AI Editing Upgrade

Started: 2026-10-30. Scope: multi-watermark manager, AI opening hook, AI background music
+ ducking, AI dynamic subtitles, centralized EditingPlan, per-job render customization,
dashboard + Telegram integration, tests + docs.

Status: **complete** (phases 1–8 done; see verification below).

## Repository audit (done)

- Stack: Express + TS NodeNext ESM (strict), `node:sqlite` DatabaseSync, jobs queue (SQLite),
  FFmpeg single-pass renders, Remotion transparent caption overlay (prores 4444) or legacy ASS,
  vanilla-JS SPA (no build), Telegram long-poll bot, faster-whisper + OpenCV python sidecars.
- Flow: upload → transcription → analysis → candidate_generation → scoring → READY.
  render_preview / render_final are on-demand jobs that bypass the chain.
- Original `renderClip()` = reframe crop → fps/scale → (remotion overlay | ass burn-in) → single ffmpeg encode → QA.
- Telegram `entry.ts` registered workers but never called `startWorker()` — fixed.
- Env facts: ffmpeg has no SVG decoder (rasterize via headless Chrome/Remotion `renderStill`);
  sidechaincompress/loudnorm/alimiter/ebur128 all available (volume filter supports timeline `enable`).

## Phase status

- [x] Phase 1: schema migration + config + settings groups (`watermark`/`hook`/`music`) + prompts + AiTask union
- [x] Phase 1b: render-options service (zod schema, presets, snapshots, plan hash)
- [x] Phase 1c: timeline service (hook moved to front, source span removed from body, duration unchanged)
- [x] Phase 2: subtitle plan (roles/animations, schema-validated, deterministic fallback) + Remotion dynamic captions (per-word style, karaoke/kinetic modes)
- [x] Phase 3: hook service (AI candidates by word index, validated; deterministic fallback)
- [x] Phase 4: watermark manager (png/webp/svg upload, strict SVG allow-list sanitizer + Chrome rasterize, multi-layer overlay, per-render overrides)
- [x] Phase 5: music library + AI selection + audio graph (loudnorm voice/BGM, speech-window ducking, fades, alimiter, ebur128 QA)
- [x] Phase 6: `render-graph.ts` + `render.ts` rewrite + `editing-plan.ts` cache + pipeline integration (snapshots, job cancellation kills ffmpeg)
- [x] Phase 6b: dashboard UI (Assets pages: Watermarks, Music; per-clip Render options panel with presets + localStorage draft)
- [x] Phase 7: Telegram UX (⚙️ Tune menu: watermark/hook/music/ducking/subtitle style/presets) + worker lifecycle fix
- [x] Phase 8: tests (54 unit incl. 29 new editing tests, 7 E2E/integration), docs, progress, final report

## Files touched (running log)

New:
- src/services/render-options.ts, timeline.ts, subtitle-plan.ts, hook.ts, music.ts, assets.ts,
  editing-plan.ts, render-graph.ts
- src/lib/remotion-bundle.ts
- remotion/WatermarkRaster.tsx
- src/routes/assets.ts, src/routes/render.ts
- test/editing.test.ts, test/render-integration.test.ts
- IMPLEMENTATION_PROGRESS.md

Changed:
- src/lib/sqlite.ts (5 tables + indexes), src/config.ts (ASSET_DIR)
- src/lib/settings.ts (3 groups), src/lib/prompts.ts (3 tasks), src/lib/ai.ts (AiTask)
- src/lib/ffmpeg.ts (jobId child registry + killJob), src/lib/queue.ts (cancel kills process,
  cancel wins over retry)
- src/services/transcribe.ts + subtitles.ts (word style, timeline-aware events)
- src/services/render.ts (composed render + loudness QA), pipeline.ts (options/snapshot/plan/jobId)
- src/services/caption-render.ts (mode/animations via remotion-bundle)
- src/routes/clips.ts (options + preset on preview/render), routes/settings.ts (groups/tasks/validation)
- src/routes/projects.ts (media scopes for watermarks/music), src/app.ts (routers)
- src/telegram/bot.ts (Tune UX), src/telegram/entry.ts (startWorker fix)
- remotion/word-state.ts, remotion/CaptionOverlay.tsx, remotion/index.tsx
- public/app.js (Assets pages + render options panel), public/style.css (reused classes only)
- .env.example (ASSET_DIR), README.md, docs/architecture.md, docs/configuration.md, docs/telegram.md
- test/env.ts (ASSET_DIR), test/run.ts (new suites)

## Migrations

All migrations are additive `CREATE TABLE IF NOT EXISTS` inside `initDb()` (idempotent,
non-destructive, no data loss for existing DBs):

- watermarks(id, name, file_path, mime, width, height, enabled, default_position, width_percent,
  opacity, margin, x, y, created_at, updated_at)
- music_assets(id, name, file_path, mime, mood, genre, energy, bpm, duration, license,
  attribution, enabled, created_at, updated_at)
- editing_plans(id, clip_id → clips ON DELETE CASCADE, version, options_hash, data, model,
  created_at, UNIQUE(clip_id, options_hash))
- render_presets(id, name UNIQUE, data, builtin, created_at, updated_at)
- render_snapshots(id, job_id, clip_id, options, created_at)

## Verification

- Baseline before changes: typecheck OK, unit 25/25 pass.
- After: `pnpm typecheck` OK; `pnpm test:unit` 55/55 pass; `pnpm test:api` 14/14 pass;
  `pnpm test e2e` 7/7 pass (real pipeline + real FFmpeg composed render incl. hook reorder,
  watermark, ducked BGM, music-only no-source-audio case; loudness QA observed).
- Live dashboard pass (Playwright): login, clips list + detail, render options panel
  (preset switch), watermark upload/edit/delete, music upload/delete, AI settings routing.
  Fixed during this pass: `hydrateRenderOptions` scope bug, `/api/ai/models` wrong URL,
  routing table missing the 3 new AI tasks, watermark thumbnail media URL.
- Render-graph fix (live repro): single-input `split`+`trim` reorder buffered the whole seeked
  window in ffmpeg RAM (3.3GB, 33min stall on a 110s 1080p clip). Replaced with one
  `-ss/-t`-seeked input per timeline segment: preview end-to-end 36s, final 2m22s,
  RSS ~400-500MB. Covered by updated `buildRenderArgs`/`buildRenderGraph` tests + e2e.

## Open issues / limitations

- SVG rasterization and the Remotion caption overlay both need the Chrome Headless Shell
  (~200 MB) downloaded once; without network the legacy `subtitles.engine=ass` path still works
  (watermark SVG uploads will fail).
- Real-AI E2E needs a live router (the suite skips gracefully when TTS/FFmpeg unavailable).
- Watermark position override in the dashboard applies to all selected watermarks (per-asset
  overrides are supported by the API/schema, the UI keeps one control for simplicity).
