# Baseline report — before AI Creative Studio work

Date: 2026-11-05 · Branch: `main` @ `7adf7f4` (working tree carries **uncommitted user changes**: the Visual Learning system — `src/services/learning.ts`, `reference-*.ts`, `style-profile.ts`, `src/routes/learning.ts`, `src/routes/references.ts`, `docs/visual-learning.md`, `test/learning.test.ts`, `test/reference-integration.test.ts`, plus edits across `src/lib/*`, `src/services/*`, `src/routes/*`, `public/app.js`. **All preserved; nothing reverted or discarded.**

## Repository shape

- Stack: Express 4 + TypeScript (NodeNext ESM), `node:sqlite` (`DatabaseSync`), zod 3, `openai` SDK → 9Router, vanilla-JS SPA (`public/app.js`, `index.html`, `style.css` — no build step), FFmpeg sidecars (`scripts/*.py`), Remotion 4 (`remotion/*.tsx`, bundled via `src/lib/remotion-bundle.ts`).
- DB: single `migrate()` with additive `CREATE TABLE IF NOT EXISTS` (`src/lib/sqlite.ts`); migrations are append-only, no version table.
- Queue: SQLite-backed FIFO (`jobs` table), serial in-process worker loop (`src/lib/queue.ts`, `src/workers/worker.ts`), job types registered in `registerWorkers()`. One job type list (`JobType`), no lanes.
- AI routing: task → model map in `ai.settings.routing` (`src/lib/ai.ts`), prompts in `prompts` table seeded from `DEFAULT_PROMPTS` (`src/lib/prompts.ts`), tolerant JSON extraction (`extractJson`), separate vision path (`chatVision`/`generateVision`).
- Settings: JSON blobs in `settings` table, deep-merged over `DEFAULT_SETTINGS` (`src/lib/settings.ts`), masked API keys in API responses.
- Storage: files on disk under `storage/` (config.dirs), SQLite keeps paths + metadata; media served authenticated through `mediaRouter` scope map with `path.basename` safety (`src/routes/projects.ts`).
- Upload validation pattern: `safeExtension` allow-list + magic bytes + size caps + ffprobe rejection (`src/services/assets.ts`, `broll.ts`). Strict SVG sanitizer (`sanitizeSvg`) exists and is reused.
- Auth: JWT httpOnly cookie (`jose`), `requireAuth` on every API router; single Super Admin.
- Frontend: hash-router SPA (`routes`, `paramRoutes`, `NAV_ITEMS`, `PAGES` object), polling helpers, toasts; `#main` replaced per page. Nav shows emoji labels.

## Baseline check results (before any modification)

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **PASS** (0 errors) |
| `pnpm test:unit` | **PASS** — 118 passed, 0 failed |
| `pnpm test:api` | **PASS** — 16 passed, 0 failed |
| `pnpm test:e2e` | **PASS** — 13 passed, 0 failed (live AI router at `AI_BASE_URL` reachable; FFmpeg + Python/whisper available) |

Environment: Windows 10.1, Node 22.19.0, pnpm, FFmpeg 9.0-full, Python 3.13.14.

## Key contracts that must not break

- `jobs` table shape + payload convention (`enqueue(type, {project_id, clip_id, payload})`); serial video pipeline Ordering: transcription → analysis → candidate_generation → scoring → render.
- `editing_plans`, `render_snapshots`, EDL schema (`validateEdl`), quality review + bounded repair (`repairEdl`).
- API envelopes (plain JSON with named keys, errors as `{error}`), 401 unauthenticated, multer single-field `file`/`video` uploads.
- `mediaRouter` scopes: previews, outputs, watermarks, music.
- Settings groups (`AllSettings`) and prompt keys (referenced by seeded rows + settings UI).

## Notes for the implementation

- Migrations must stay additive; new design tables go in the same `migrate()` block. The `jobs` table needs a new nullable/defaulted column (`lane`) — one guarded `ALTER TABLE` is the only shared-infra schema change required.
- No browser e2e (headless UI) framework exists; UI is verified by API tests + manual smoke via the editor pages.
