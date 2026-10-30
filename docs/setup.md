# Setup

## 1. Prerequisites

- **Node.js 20+** (`node --version`) and **pnpm** (`corepack enable` then `pnpm --version`).
- **FFmpeg + FFprobe** on `PATH`:
  ```powershell
  ffmpeg -version ; ffprobe -version
  ```
  On Windows the gyan.dev full build works. Anything with `libx264` and `aac` is fine.
- **Python 3.10+** (`python --version`). Packages are listed in `requirements.txt`.
- An **OpenAI-compatible endpoint** for the LLM work. The default expects a local
  router at `http://localhost:20128/v1`, but any OpenAI-compatible base URL works.

## 2. Install

```powershell
pnpm install
python -m pip install --user -r requirements.txt
```

`av<19` and `huggingface-hub<2` are pinned on purpose. faster-whisper 1.2.x calls
`av.open(..., metadata_errors=...)`, removed in PyAV 19 — upgrading breaks transcription.

## 3. Configure

```powershell
copy .env.example .env
```

Edit `.env` with at least:

- `ADMIN_PASSWORD` — the Super Admin password (created once, on `db:init`).
- `SESSION_SECRET` — a long random string (32+ bytes).
- `AI_BASE_URL` and `AI_API_KEY` (or `ROUTER_API_KEY`).
- `PORT` — defaults to 3000; this project’s `.env` uses 4730.

See [configuration.md](configuration.md) for every variable.

## 4. Initialise the database

```powershell
pnpm db:init
```

Creates the SQLite schema, seeds the default prompts, and bootstraps the Super Admin
(`ADMIN_USERNAME` / `ADMIN_PASSWORD`). Safe to re-run; an existing admin is not duplicated.

## 5. Build and run

```powershell
pnpm build
pnpm start        # http://localhost:4730  (or your PORT)
```

Open the URL, log in with the admin credentials, and drop a video onto the dashboard.

The **first transcription downloads the Whisper model** (`base` ≈ 140 MB) into the
Hugging Face cache — the first run is slower and needs network access.

## Development

```powershell
pnpm dev          # tsx watch, reloads on change
```

## Verifying the install

1. `/api/health` (or Settings > System) should show every service green:
   Database, 9Router, FFmpeg, FFprobe, Whisper, OpenCV, Queue, Telegram, Storage.
2. Run the tests:
   ```powershell
   pnpm test
   ```
   This needs FFmpeg, Python, a live router, and network access for the Whisper model.

## Running behind HTTPS / a tunnel

Set `BASE_URL` to the public URL and leave `TRUST_PROXY=true` so the session cookie is
marked `Secure`. See [cloudflare-tunnel.md](cloudflare-tunnel.md).
