# AI Video Clipper

Local-first video clipper: upload a long video, and it transcribes it, asks an LLM
(served through a 9Router-compatible OpenAI endpoint) to find the best moments,
scores and deduplicates them, reframes to vertical, burns subtitles, and renders
ready-to-post clips. Everything runs on your machine — one Node server, one SQLite
file, FFmpeg, and a local Whisper model.

Control it from a web dashboard or a Telegram bot.

## What it does

1. **Upload** — web (drag/drop) or Telegram. FFprobe validates it is real video and records metadata.
2. **Transcribe** — `faster-whisper` (default `base`, CPU/int8) with word-level timestamps.
3. **Analyse** — a routed LLM model finds content moments and highlight candidates from the transcript.
4. **Score & refine** — each candidate is scored (hook, retention, emotion, clarity, payoff, length),
   boundaries are snapped to sentence edges and refined, then overlapping clips are deduplicated.
5. **Render** — face-tracked reframe (9:16 / 1:1 / 16:9), animated captions via Remotion
   (SRT/ASS still exported), H.264/AAC MP4 with `+faststart`, plus a QA pass (duration,
   resolution, streams, size, sanity frame).
6. **Deliver** — preview or final in the browser, or push to Telegram.

All AI steps are controlled: the model returns structured JSON only. It can never run shell
commands or touch files; edits are validated against a fixed operation whitelist (`src/lib/tools.ts`).

## Requirements

- Windows (primary target) with **PowerShell 5.1**; Linux/macOS also work except the bundled TTS fixture.
- **Node.js 20+** and **pnpm**.
- **FFmpeg + FFprobe** on `PATH` (build with libx264/aac).
- **Python 3.10+** with the packages in [`requirements.txt`](requirements.txt).
- An OpenAI-compatible router at `AI_BASE_URL` (default `http://localhost:20128/v1`) and an API key.

> `av<19` and `huggingface-hub<2` are pinned on purpose — faster-whisper 1.2.x breaks on newer PyAV
> (`metadata_errors` was removed in PyAV 19).

## Quick start

```powershell
# 1. install
pnpm install
python -m pip install --user -r requirements.txt

# 2. configure
copy .env.example .env
#    edit .env: set ADMIN_PASSWORD, AI_BASE_URL, AI_API_KEY (or ROUTER_API_KEY), SESSION_SECRET

# 3. initialise the database + Super Admin
pnpm db:init

# 4. build + run
pnpm build
pnpm start          # http://localhost:4730
```

Log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.

The first transcription downloads the Whisper model (a few hundred MB for `base`).

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the server with hot reload (`tsx watch`). |
| `pnpm build` | TypeScript compile to `dist/`. |
| `pnpm start` | Run the built server (`dist/src/index.js`). |
| `pnpm worker` | Worker-only process (the web server already runs an in-process worker). |
| `pnpm telegram` | Run the Telegram bot (`src/telegram/entry.ts`). |
| `pnpm db:init` | Create tables, seed prompts, bootstrap the Super Admin. |
| `pnpm test` | Unit + API + E2E against a temp DB (needs FFmpeg, Python, and a live router). |
| `pnpm test:unit` / `test:api` / `test:e2e` | Run one suite. |
| `pnpm typecheck` | `tsc --noEmit`. |

## Documentation

- [Architecture](docs/architecture.md) — modules, data model, job pipeline.
- [Setup](docs/setup.md) — install and first run, in depth.
- [Configuration](docs/configuration.md) — every `.env` variable and settings group.
- [AI models](docs/ai-models.md) — task routing, prompts, safety model.
- [Telegram](docs/telegram.md) — bot setup and commands.
- [Cloudflare Tunnel](docs/cloudflare-tunnel.md) — expose the dashboard safely.
- [Troubleshooting](docs/troubleshooting.md) — common failures and fixes.

## Stack

Express + TypeScript (NodeNext ESM) · `node:sqlite` (`DatabaseSync`) · JWT httpOnly session
cookies (`jose`) · bcryptjs · multer · zod · the `openai` SDK pointed at a 9Router base URL ·
vanilla-JS SPA (no build step) · FFmpeg + faster-whisper + OpenCV sidecars ·
Remotion (caption overlay rendering).

## License

Private / unlicensed unless stated otherwise.
