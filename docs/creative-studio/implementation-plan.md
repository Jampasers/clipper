# AI Creative Studio — implementation plan

Goal: evolve Clipper into an AI Creative Studio (Video + Design + Social + Campaign),
with a **working Hybrid Design Studio** (raster assets from AI, editable text/image/
shape/group layers, real exports). Video pipeline is production-critical and untouched
except additive, regression-tested changes.

Stack stays: Express + TS + `node:sqlite` + zod + vanilla-JS SPA + FFmpeg + Remotion.

## Phase 0 — Baseline (done)

`docs/creative-studio/baseline.md` records the repo audit and green baseline
(typecheck, 118 unit, 16 API, 13 e2e — all passing before changes).

## Phase 1 — Infrastructure

1. **DesignDocument schema** (`src/design/document.ts`, zod):
   canvas, metadata, assets[], layers[] (text/image/shape/group), settings;
   `schemaVersion`, strict validation, migration, serialization.
2. **DB migrations** (additive, `src/lib/sqlite.ts`):
   `design_documents`, `design_versions`, `design_assets`, `design_templates`,
   `design_generations`, `design_reviews`, `campaigns`, `campaign_outputs`;
   `ALTER TABLE jobs ADD COLUMN lane TEXT DEFAULT 'video'` (guarded).
3. **Queue lanes** (`src/lib/queue.ts`, `src/workers/worker.ts`):
   lane derived from job type (video/design/campaign); per-lane serial drain loops
   start video first (no starvation); per-lane concurrency configurable (default 1).
   Legacy payloads unchanged.
4. **Design asset library** (`src/services/design-assets.ts`): upload validation
   (ext + magic bytes + size + ffprobe), metadata in SQLite, files on disk,
   reference-safe delete, font registry.
5. **Image generation provider** (`src/services/image-provider.ts`): independent
   abstraction, OpenAI-compatible images endpoint from settings, timeout/retry,
   validation of returned bytes, typed `ImageGenerationUnavailableError`,
   never fabricates assets.
6. **AI routing extensions**: new tasks `creative_brief_analysis`,
   `design_art_direction`, `design_layout`, `design_copywriting`, `design_variants`,
   `design_quality_review`, `design_repair` (`src/lib/prompts.ts`, `ai.ts`).

## Phase 2 — Design Studio MVP

1. **Layout engine** (`src/design/layout.ts`): deterministic grid/margins/safe area,
   strategies (editorial, minimalist, modern_promo, bold_typography, product_showcase,
   event_poster, corporate, luxury, social), validation (bounds, overflow, collisions).
2. **Typography engine** (`src/design/typography.ts`): font registry, metric-based
   width estimation, wrap + overflow detection.
3. **SVG renderer** (`src/design/render.ts`): DesignDocument → SVG, deterministic,
   fully escaped; used for preview, SVG export and rasterization.
4. **Art Director** (`src/design/artdir.ts`): AI task chain with zod-validated
   schemas + **deterministic fallbacks** (design generation works without AI);
   `ArtDirection` object (palette, typography, hierarchy, composition, asset plan).
5. **Generation service** (`src/services/design-jobs.ts`): brief → art direction →
   copy → layout → document; variants with genuinely different composition;
   persisted + versioned. Queue lane `design`.
6. **API** (`src/routes/designs.ts` + `design-assets.ts` + `templates.ts`):
   CRUD, duplicate, versions/restore, generate, variants, review, export.
7. **Exports** (`src/design/export.ts`): SVG (direct), PNG/JPG (Remotion Chromium
   rasterizer), PDF (minimal honest writer embedding JPEG via DCTDecode).
8. **Editor UI** (`public/design-studio.js`, loaded before `app.js`):
   layer list, SVG canvas with select/move/resize/rotate, property inspector
   (position/size/rotation/typography/fill/stroke/opacity/fit), undo/redo,
   save/save-as, duplicate, version restore, template gallery, generate modal,
   asset upload, export dialog. Nav: new "Design" group.

## Phase 3 — Quality, templates, variations

Deterministic review checks + bounded whitelisted repair (`src/design/review.ts`),
design variants endpoint, template CRUD (editable DesignDocuments), brand assets
(logo upload into design asset library), PDF/SVG export verified.

## Phase 4 — Social Studio

Format presets (IG 1080×1350 / 1080×1080 / 1080×1920, YT thumb 1280×720,
A4 portrait/landscape), composition re-layout per aspect (not stretch), batch export
endpoint, UI actions.

## Phase 5 — Campaign Studio

`campaigns` + `campaign_outputs` tables, one brief → multiple outputs across
formats, shared palette/brand, video-studio link through existing clip APIs.

## Phase 6 — Visual Learning 2.0

Design-domain references (poster/flyer uploads) analyzed into style metadata stored
separately from the video learning domain; user-feedback signals (saved/edited/
rejected) recorded as preference events; art director consults them after explicit
brief/brand/references. Additive on top of the existing video learning tables.

## Guardrails

- Every phase ends with `pnpm typecheck` + `pnpm test:unit` + `pnpm test:api`
  (+ `pnpm test:e2e` where it runs).
- Video regression: baseline suites must stay green; queue changes carry
  regression tests for payload/behavior compatibility.
- No new dependencies unless proven necessary (current plan: none).
