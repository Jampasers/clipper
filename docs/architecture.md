# Architecture

## Layer map

```
public/                     vanilla-JS SPA (no build step)
src/
  index.ts                  bootstrap: config, listen, in-process worker loop
  app.ts                    createApp(): express app + routers + static
  config.ts                 all environment-derived config (single source)
  lib/
    sqlite.ts               node:sqlite wrapper (q/qget/qall helpers), migrations
    settings.ts             typed settings groups + defaults + deep merge
    prompts.ts              default AI prompt templates, seeded into DB
    ai.ts                   OpenAI-compatible client, task routing, JSON extraction
    auth.ts                 bcrypt + Super Admin bootstrap
    session.ts              jose JWT in an httpOnly cookie (HS256, 7 days)
    middleware.ts           loadSession / requireAuth
    queue.ts                SQLite-backed job queue (enqueue/claim/processOne/retry)
    tools.ts                controlled tool layer + edit-op whitelist (NO shell)
    ffmpeg.ts               runCmd / probeVideo / parseFps helpers
    log.ts                  leveled logger with service tags
    health.ts               service health checks (DB, router, ffmpeg, whisper, ...)
  routes/
    auth.ts                 login/logout/me/change-password
    projects.ts             upload (multer), CRUD, source stream, media files, jobs
    clips.ts                list/get/patch/preview/render/reject/ai-edit
    settings.ts             settings CRUD, prompt CRUD, AI test endpoints
    dashboard.ts            counts + recent activity
  services/
    projects.ts             createProject (moves upload into projects/<id>/)
    transcribe.ts           faster-whisper sidecar (scripts/transcribe.py), SRT-backed cache
    analysis.ts             content analysis + highlight candidates + scoring helpers
    boundary.ts             sentence-edge snapping and boundary optimisation
    pipeline.ts             job handlers wiring the whole project flow
    clips.ts                clip persistence, selection (top-N), view mapping
    reframe.ts              face tracking (scripts/track_faces.py) -> crop keyframes
    subtitles.ts            segment->cue building, ASS/SRT, emphasis presets
    render.ts               ffmpeg arg building, render, QA checks
    clip-edit.ts            natural language edit -> whitelisted ops -> clip patch
  telegram/                 long-polling bot (token-gated to one numeric user id)
  workers/worker.ts         registers all handlers + background polling loop
scripts/
  transcribe.py             faster-whisper worker (JSON-lines progress on stdout)
  track_faces.py            OpenCV Haar face tracking -> centre-x samples
  tts.ps1                   Windows SAPI TTS (used to synthesise the E2E fixture voice)
  init-db.ts                pnpm db:init
test/                       custom runner; unit / api / e2e
```

## Data model (SQLite)

| Table | Purpose |
| --- | --- |
| `users` | Super Admin + future accounts (bcrypt password hash). |
| `projects` | name, status, source path, probe metadata (JSON), error. |
| `transcripts` | JSON segments with word timings per project. |
| `analyses` | typed rows: `moments`, `candidates` (JSON payloads). |
| `clips` | candidate window, refined boundary, scores, aspect, subtitle preset, emphasis, status. |
| `jobs` | queue rows: type, payload JSON, status, attempts, progress. |
| `settings` | one row per settings group, JSON merged over defaults. |
| `prompts` | editable prompt templates keyed by AI task. |
| `logs` | structured job/system log lines surfaced in Settings > Logs. |

## Pipeline

```
upload -> probe -> [queue] transcription -> analysis -> candidate_generation
        -> scoring (score + boundary refine + dedup) -> READY (clips persisted, top-N selected)
render: preview | final | telegram  (separate queue jobs, QA-checked)
```

Each stage is a job type registered in `src/workers/worker.ts`. `processOne()` claims the
oldest `queued` job, runs its handler, and stores progress; the server runs it in a loop
(`startWorker`), and `pnpm worker` can run the same loop standalone (e.g. with the Redis
driver for multi-process).

## AI control plane

- One OpenAI-compatible client (`src/lib/ai.ts`), base URL + key from settings.
- `ai.routing` maps each task (`content_analysis`, `highlight_detection`, `clip_scoring`,
  `clip_boundary`, `title_generation`, `subtitle_analysis`) to a model; requests retry on
  5xx/429 and on malformed JSON, then fall back to `ai.fallback_model`.
- `extractJson` tolerates code fences and *recovers truncated JSON* (models occasionally cut
  off mid-array; we close brackets and drop the incomplete last element).
- The model can only return JSON and (for chat edits) edit operations validated against a
  fixed whitelist in `src/lib/tools.ts`. There is no shell, fs, or eval surface reachable from AI output.

## Security model

- Sessions: HS256 JWT in an httpOnly, SameSite=Lax cookie; `Secure` when `TRUST_PROXY`/`BASE_URL` set.
- Uploads: multer memory -> FFprobe validation (must be a decodable video) -> moved into `storage/projects/<id>/`.
- Media files are served only through allow-listed directories (`/api/media/:scope/:file` sanitises path parts).
- Only the bootstrapped Super Admin exists; login is rate-limited by bcrypt cost and failed-login logs.
