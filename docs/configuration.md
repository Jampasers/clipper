# Configuration

Two layers: **environment variables** (`.env`, read at startup) and **settings groups**
(stored in SQLite, editable from the dashboard and taking effect without a restart).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `BASE_URL` | `http://localhost:$PORT` | Public URL; enables `Secure` cookies when not localhost. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from a reverse proxy / tunnel. |
| `SESSION_SECRET` | dev fallback | HS256 signing key for session JWTs. Set a real one. |
| `DATABASE_URL` | `./data/app.db` | SQLite database file. |
| `ADMIN_USERNAME` | `admin` | Super Admin username (bootstrap). |
| `ADMIN_PASSWORD` | (empty) | Super Admin password (bootstrap). |
| `AI_BASE_URL` | `http://localhost:20128/v1` | OpenAI-compatible base URL. |
| `AI_API_KEY` | (empty) | Router API key. |
| `ROUTER_API_KEY` | (empty) | Env-only fallback for `AI_API_KEY`. |
| `AI_DEFAULT_MODEL` | `rv/deepseek-ai/DeepSeek-V4.1-Flash` | Default model for all AI tasks. |
| `TELEGRAM_BOT_TOKEN` | (empty) | Enables the bot when set. |
| `TELEGRAM_ALLOWED_USER_ID` | (empty) | Only this numeric user id may use the bot. |
| `INPUT_DIR` | `./storage/inputs` | Incoming uploads. |
| `PROJECT_DIR` | `./storage/projects` | Per-project source + artifacts. |
| `TEMP_DIR` | `./storage/temp` | Scratch (extracted audio, part files). |
| `PREVIEW_DIR` | `./storage/previews` | Rendered previews. |
| `OUTPUT_DIR` | `./storage/outputs` | Final renders. |
| `ASSET_DIR` | `./storage/assets` | Watermark images (`watermarks/`) and the music library (`music/`). |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable. |
| `FFPROBE_PATH` | `ffprobe` | FFprobe executable. |
| `PYTHON_PATH` | `python` | Python for the whisper / opencv sidecars. |
| `WHISPER_MODEL` | `base` | `tiny` \| `base` \| `small` \| `medium` \| `large-v3`. |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda`. |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8`, `int8_float16`, `float16`, `float32`. |
| `QUEUE_DRIVER` | `sqlite` | `sqlite` (built-in) or `redis`. |
| `REDIS_URL` | `redis://localhost:6379` | Used when `QUEUE_DRIVER=redis`. |

## Settings groups (dashboard > Settings)

Each group is a JSON blob merged over defaults in `src/lib/settings.ts`.

### `ai`
- `base_url`, `api_key` (masked in responses), `default_model`, `fallback_model`
- `temperature`, `max_tokens`, `timeout_ms`, `request_retries`
- `routing` — per-task model overrides:
  `content_analysis`, `highlight_detection`, `clip_scoring`, `clip_boundary`,
  `title_generation`, `subtitle_analysis`, `hook_generation`, `subtitle_plan`,
  `music_selection`

Endpoints: `POST /api/settings/ai/test` (connectivity), `POST /api/settings/ai/test-model`
(send a prompt to a specific model), `GET /api/settings/ai/models` (list router models).

### `clipping`
- `min_clip_duration`, `max_clip_duration`, `target_clip_duration` (seconds)
- `top_clips` (how many to auto-select), `max_candidates`, `overlap_threshold` (0–1 dedup)
- `pad_before` / `pad_after` (seconds of breathing room around the cut)

### `scoring`
Plain weights summed per candidate (higher = more influential):
`hook`, `context`, `standalone`, `emotion`, `entertainment`, `payoff`, `curiosity`,
`shareability`, `length`.

### `subtitles`
- `enabled`, default `preset`, and per-clip override.
- `engine` (`remotion` | `ass`, default `remotion`): `remotion` renders animated captions
  (per-word karaoke highlight, fade/typewriter) as a transparent overlay that FFmpeg
  composites over the video; `ass` is the legacy FFmpeg `subtitles=` burn-in. The first
  `remotion` render downloads Chrome Headless Shell once (~200 MB) and is slower than
  the old burn-in (headless Chrome renders the caption layer frame by frame).
- `emphasis`: `enabled`, `color`, `scale_percent`, `bold` — keyword highlighting.
- Presets `classic | bold | minimal | karaoke | podcast`, each with `font`, `font_size`,
  `position` (`bottom` | `middle`), `margin_v`, `max_chars_per_line`, `max_words_per_line`,
  `max_lines`, `primary_color`, `outline_color`, `outline_width`, `bold`, `uppercase`,
  `karaoke`, `karaoke_color`, `animation` (`none` | `fade`).

### `reframe`
- `aspect` (`9:16` | `1:1` | `16:9`), `face_tracking` (OpenCV Haar), `sample_interval`
  (seconds between face samples), `smoothing_window` (moving average), `max_speed`
  (px/s pan limit at output scale), `deadzone` (px before the camera moves).

### `render`
- `width`/`height` (final, default 1080×1920), `fps`, `vcodec libx264`, `acodec aac`,
  `crf`, `bitrate` (optional override), `audio_bitrate`, `preset`, `pixel_format`,
  `container`, and `preview_*` variants (default 540×960, crf 30).

### `watermark`
- `enabled` (overlay watermarks on renders by default), `default_position` (`top-left`,
  `top-right`, `bottom-left`, `bottom-right`, `center`, `custom`), `default_width_percent`,
  `default_opacity`, `default_margin`. Manage images under **Assets > Watermarks**
  (`/api/assets/watermarks`); per-render overrides never edit these rows.

### `hook`
- `enabled` (AI opening hook), `duration` (target seconds, default 7, render range 3–15),
  `min_duration`, `max_duration`, `allow_fallback` (deterministic candidate when AI fails).

### `creative`
- `mode` (`adaptive` | `basic` — adaptive runs the Creative Director + EDL pipeline),
  `quality_review` (static + media review with one bounded repair), `graphics`
  (Remotion graphics overlay: titles/cards/callouts/progress bar). See
  [AI Creative Editor](creative-editor.md). Presets `clean`/`minimal` force `basic`.

### `music`
- `enabled`, `selection` (`ai` | `none` | a music asset id — also set per render),
  `volume_db` (BGM gain offset), `duck_db` (lower BGM while someone speaks),
  `fade_in` / `fade_out` (seconds), `voice_ducking`, `voice_target_lufs` (-16),
  `music_target_lufs` (-17), `true_peak_db` (-1 dBTP limiter ceiling).

### `telegram`
- `enabled`, `send_progress`.

### `pipeline`
- `whisper_model`, `whisper_language` (`auto` or an ISO code), `word_timestamps`.

## Prompts

`prompts` are seeded from `DEFAULT_PROMPTS` and editable at `/api/prompts`. Each prompt
has `{{variables}}` (rendered from the pipeline). Settings > Prompts lets you edit, test
against a real model, and reset to defaults.
