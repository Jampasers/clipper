# Design Studio

The Design Studio generates and edits static graphics (social posts, promos, posters,
slides) with the same philosophy as the video pipeline: **AI proposes, deterministic code
disposes**. Every generated design is an editable document, renders identically in the
browser and in exports, and works with no AI configured at all.

## Core idea: the DesignDocument

A design is not a PNG — it is a JSON document (`src/design/document.ts`, zod-validated):

```
canvas { width, height, background: solid|gradient|image, safeArea }
layers[]  text | image | shape (group reserved)  — ordered, back to front
  → x/y/width/height, rotation, opacity, visible, locked
  → text:   style {fontFamily, fontSize, fontWeight, lineHeight, letterSpacing,
                   align, color, uppercase, overflow: shrink|hidden}
  → image:  assetRef (library asset id — never a filesystem path), fit, focus
  → shape:  fill (solid or linear gradient), cornerRadius, stroke, shadow
metadata { title, tags, strategy, palette[] }
assets[] (library references) · settings.export { format, scale, quality }
```

Invariants enforced by code, not convention:

- **Layer boxes are in canvas coordinates.** `validateDocument` rejects anything outside
  a generous bounds envelope; the deterministic repair pass pulls strays back inside.
- **Images reference the asset library** (`assetId`), so documents survive asset moves.
- **Facts are protected.** Text layers created from brief facts (dates, prices, contacts)
  are flagged `protected: true`; AI repair ops may recolor them but never re-time or
  re-align them (`src/design/review.ts: applyRepairs`).
- `schemaVersion` + migration keeps stored documents forward-compatible.

## Generation pipeline (design lane)

`POST /api/designs` (or regenerate on an existing design) enqueues a `design_generate`
job on the **design queue lane** — it can never starve video rendering
(`src/lib/queue.ts` lanes: `video` > `design` > `campaign`).

1. `analyzeBrief` — extract structured facts (brand, offer, date/time, address, CTA).
   **These facts are protected downstream.**
2. `getArtDirection` — concept, composition (9 strategies), palette (hex), typography,
   background mode, optional image prompt. Falls back deterministically from the brief.
3. `planCopy` — role-typed copy blocks (headline, sub, cta, price, date, contact…).
   Protected facts are carried over verbatim, never rewritten.
4. Optional: image-provider generates a raster hero/background. Without a provider the
   layout uses a gradient background — generation still succeeds.
5. `buildLayout` (`src/design/layout.ts`) — the AI chooses the *strategy*; this module
   computes every coordinate: margins, safe area, palette→ink/contrast, type ramp
   (`typography.scale` × role base × canvas width), CTA pill, detail stacks placed
   relative to real font metrics. Variants rotate the composition strategy, so
   "4 variants" are genuinely different layouts, not nudged copies.
6. `deterministicReview` → optional `deterministicRepair` (bounds, text overflow →
   `overflow: shrink`) → snapshot → save (r+1) → review row stored.

Every AI step has a deterministic fallback; a fresh install with zero AI config still
produces a valid, editable, exportable design.

## Rendering: one path, no drift

`renderDocumentSvg` (`src/design/render.ts`) is the **only** renderer:

- Editor preview: the SPA posts the current document to `POST /api/designs/preview`
  and displays the returned SVG. Dragging moves a DOM transform live; pointer-up
  commits to the document and re-renders server-side. No client-side SVG editing.
- Exports rasterize the **same** SVG (fonts inlined as data URIs, images embedded) via
  headless Chromium (`rasterizeSvgToImage`).
- Missing assets render a visible marker layer instead of failing the whole preview.

## Exports

`POST /api/designs/:id/export { format, scale, quality }` (synchronous) →
`src/design/export.ts`:

| format | path |
| --- | --- |
| `svg` | embedded SVG written directly |
| `png` / `jpg` | headless Chromium raster of the embedded SVG |
| `pdf` | single-page raster PDF written by a minimal PDF writer (JPEG `DCTDecode`, valid xref/trailer) — honest raster pages, not fake vector |

Files land in `storage/designs/exports/` and are served via the
`design-exports` media scope. Thumbnails (`POST /:id/thumbnail`) render a small PNG to
`storage/designs/thumbs/` for the gallery; generation sets one automatically
(best-effort — a cold browser can time out without failing the design).

## Versioning & templates

- Every `PUT /save` snapshots the previous document into `design_versions` with a label
  (`manual save`, `auto (before generation commit)`, …) before bumping the revision.
  `POST /:id/versions/:rev/restore` restores as a **new** revision (safe undo).
- Templates (`/api/templates`) store documents + palette + preferred strategy.
  `POST /:id/apply` instantiates a template as a new editable design.
- `duplicate`, `delete` (reference-checked against templates), `saveReview`, and
  `design_generations` bookkeeping (kind/status/error per AI run) round out the service
  layer (`src/services/designs.ts`).
- Deterministic review + one-click **Auto-repair** (`design_repair` job) and queued
  **review with AI vision** (`review.ai` setting) are available from the editor.

## Asset library

`/api/design-assets` (`src/routes/design-assets.ts`): upload (multer), fonts list,
independent image-provider status/test, per-asset reference counting
(documents + templates referencing it) and reference-safe delete (`?force=1` overrides).

## AI task routes

Eight new prompt/task slots (masked, editable in **Models & Routing** → design group):
`creative_brief_analysis`, `design_art_direction`, `design_copywriting`,
`design_variants_copy`, `design_review_vision`, `design_repair`, `design_social_batch`,
`campaign_generate`. The **image provider** is configured separately
(`design.image_provider`) — see [image providers](#image-providers); generation degrades
to gradient backgrounds when absent.

## Image providers

Independent of the chat router. Supported: `openai_compatible` (images/generations or
chat-with-image models), `pollinations` (free, keyless), `none`. Configured under
**Settings → Design** with a *Test* button. Whatever it returns is registered as a
regular library asset; failure raises `ImageGenerationUnavailableError` and the job
falls back to a gradient — assets are never faked.

## Frontend

`public/design-studio.js` extends the vanilla SPA (loaded before `app.js`, merged via
`window.DesignRoutes/DesignPages/DesignNav`). Pages: gallery (`#/designs`) with
search/status filters and thumbnail cards, editor (`#/designs/:id`) — server-rendered
canvas, layer list (reorder/visibility), properties panel, add text/rect/image,
generate/export/review/versions panels, status polling for in-flight generations —
and templates (`#/templates`). Editor styles live under `.ds-*` in `public/style.css`.

## API surface

```
GET/POST   /api/designs                 list / create (+ optional generate)
POST       /api/designs/preview         render a document to SVG (editor)
GET        /api/designs/:id             detail {design, document, box}
PUT/DELETE /api/designs/:id             save (snapshot first) / delete
POST       /api/designs/:id/{duplicate,generate,variants,review,repair,thumbnail,export}
GET        /api/designs/:id/preview.svg
GET        /api/designs/:id/versions    POST …/versions/:rev/restore
GET        /api/designs/:id/{reviews,generations}
GET/POST   /api/templates               …/:id, /:id/apply, /:id/duplicate, DELETE /:id
GET/POST   /api/design-assets           …/fonts, /image-provider, /image-provider/test
PATCH/DELETE /api/design-assets/:id     GET …/:id/references
```

## Tests

- `test/design.test.ts` — schema, deterministic layout (+bounds/variants), typography,
  review/repair incl. protected-text rules, SVG escaping + missing-asset marker,
  SVG/PDF export structure, services (versions/restore/duplicate/templates/validation).
- `test/api.test.ts` — design CRUD/preview/versions/templates/API export (SVG + real
  PNG through headless Chromium), asset upload → media → delete.
