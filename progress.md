# Progress — AI Creative Studio (video + design)

_Last updated: 2026-11-05_

## Status: shipped

Both halves of the studio are implemented, tested and verified end-to-end:

1. **AI Video Clipper** (pre-existing, untouched core) — upload → transcribe → analyse →
   score → reframe/subtitles/music → render → deliver, with adaptive editing and
   visual learning.
2. **Design Studio** (this phase) — AI-assisted static graphics with a hybrid
   edit model: deterministic layout engine + editable documents + real exports.

## Design Studio deliverables

- **Document model** (`src/design/document.ts`): zod-validated `DesignDocument`
  (canvas, ordered text/image/shape layers, protected-fact flags, export settings),
  migration + reference validation.
- **Deterministic layout engine** (`src/design/layout.ts`, `typography.ts`,
  `color.ts`): 9 composition strategies fed by AI art direction; contrast-aware ink,
  type ramp from canvas size, CTA pill, metric-aware detail stacks; variants rotate
  strategies (genuinely different layouts).
- **Single renderer** (`src/design/render.ts`): `renderDocumentSvg` powers editor
  preview and exports — no client/server rendering drift; escaping + visible
  missing-asset markers.
- **AI chain with fallbacks** (`src/design/artdir.ts`, `src/lib/prompts.ts`): brief
  analysis → art direction → copy; brief facts protected end-to-end; every step has a
  deterministic fallback (works with zero AI).
- **Review/repair** (`src/design/review.ts`): deterministic issues + bounded repair;
  protected text may be recolored, never re-timed/re-aligned.
- **Exports** (`src/design/export.ts`): embedded SVG, PNG/JPG via headless Chromium,
  single-page raster PDF (own minimal writer, JPEG DCTDecode); thumbnails; export/
  thumb dirs under `storage/designs/` with media scopes.
- **Persistence + jobs** (`src/services/designs.ts`, `design-jobs.ts`,
  `src/lib/queue.ts` lanes): versioned saves (snapshot-before-save), restore-as-new-
  revision, duplicate, delete, templates (create/apply/duplicate), reviews,
  `design_generations` bookkeeping; design queue lane can never starve video.
- **Asset library** (`src/services/design-assets.ts`, `src/routes/design-assets.ts`):
  uploads, fonts, independent image provider (openai-compatible / pollinations / none)
  with test button, reference counting + reference-safe delete.
- **SPA** (`public/design-studio.js` + hooks in `app.js`, `.ds-*` styles): gallery,
  editor (server-SVG canvas, live drag with server re-render on commit, layer list,
  properties, generate/export/review/versions panels, status polling), templates page.
- **Settings** (`design` group): concurrency (design lane 1–4), review auto_repair,
  review AI, image provider config + 8 new AI task routes (masked, editable).
- **Additive tables** in `src/lib/sqlite.ts`: design_documents/versions/assets/
  templates/reviews/generations (+ campaigns/campaign_outputs reserved), `jobs.lane`.

## Verification

| Suite | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm test:unit` | 140 passed, 0 failed |
| `pnpm test:api` | 19 passed, 0 failed |
| `pnpm test:e2e` | 13 passed, 0 failed |
| Manual smoke (isolated DB, live router) | login → create+generate (live AI) → editor render → drag/save (x 70.2→233, r5) → restore r4 → review job → export svg/png/jpg/pdf (`%PDF-` verified) → templates create/apply → gallery thumbnails |

Bugs found & fixed during smoke: details/CTA overlap in `modern_promo` (metric-aware
stack spacing), SVG text hit-testing (Chromium `pointer-events: bounding-box`), hash
query poisoning router ids (query stripped in `app.js` router), review-panel job race
(delayed refresh).

## Constraints honored

- No new npm dependencies (stdlib + existing stack only).
- Video pipeline untouched; all shared-infra changes additive and regression-tested.
- No AI fabrication: missing image provider → gradient fallback + honest warnings;
  missing assets render markers, never fake content.
- Working tree also carries the (preserved, separate) Visual Learning changes.

## Docs

- `docs/creative-studio/design-studio.md` (architecture, engine, document model,
  exports, API) · README feature section + doc index.
