# Troubleshooting

Health first: `GET /api/health` lists every service. Anything not `ok` points at the fix below.

## AI calls

| Symptom | Cause / fix |
| --- | --- |
| `401 Invalid API key` on every AI job | `ai.api_key` empty or wrong. Set `AI_API_KEY` (or `ROUTER_API_KEY`) and/or Settings > AI. Router model listing works without auth — only completions need the key. 401s are deliberately **not** retried. |
| `404 model not found` | Model name changed. Load models in Settings > AI, pick one from the real list, and update `ai.routing` (old defaults like `deepseek-v4.1-flash` can be stale). |
| `unterminated JSON` / `malformed JSON` | Model truncated the JSON. Already auto-repaired by `extractJson` and auto-retried up to 4× + fallback model. If it still fails, use a stronger model for `content_analysis` / `clip_scoring`. |
| AI looks bad | Wrong prompt — edit it in Settings > Prompts and run "test" with a live model before saving. |

## Transcription

| Symptom | Cause / fix |
| --- | --- |
| `Video has no audio stream` | Source genuinely has no audio track, or a stale `.ass/.wav` cache path. Check `ffprobe` on the file in `storage/projects/<id>/`. |
| `open() got an unexpected keyword argument 'metadata_errors'` | PyAV too new. `python -m pip install --user "av<19" "huggingface-hub<2"` (see `requirements.txt`). |
| First transcription very slow / downloads | Whisper model download (`base` ≈ 140 MB). It lands in the HF cache; later runs are fast. |
| `transcribe exited 1` | Read the line after it; it's the Python traceback (first 300 chars). Common: missing `faster_whisper` (`pip install --user -r requirements.txt`) or wrong `PYTHON_PATH`. |
| Garbage words | Try a bigger `WHISPER_MODEL` (`small`) or whisper_language set explicitly instead of `auto`. |

## Rendering

| Symptom | Cause / fix |
| --- | --- |
| `Error opening output file ... .part` | ffmpeg can't infer the muxer from a temp name. Temp files must keep a real extension — the code uses `*.tmp.wav` / `*.part.mp4`; if you patch it, keep one. |
| Output has no subtitles | Segment timestamps outside `clip.start..end`, or subtitle preset disabled in settings. Rebuild cues after editing bounds. |
| QA fails "sanity frame" | Source unreadable at the probe's container; check the file isn't truncated. |
| 9:16 crop shows black bars / off-centre | Face tracking found centred faces or used the static fallback. Check `reframe.face_tracking` and the `track_faces` script (OpenCV). |

## Jobs / queue

- **Job stuck in `running` after a restart**: `POST /api/jobs/:id/retry` (System > Queue)
  requeues it; the next worker tick picks it up.
- **Two processes fighting for jobs**: the DB queue uses atomic claims, but don't run both
  `pnpm start` and `pnpm worker` unless you intend two workers on the same DB.
- **`Redis` mode**: `QUEUE_DRIVER=redis` + `REDIS_URL`; Redis must be running (see
  `docker compose up -d redis`).

## Server / web

| Symptom | Fix |
| --- | --- |
| `ECONNREFUSED` on `pnpm test:api` | Test suite bug, not server: the express server must outlive test registration (it's closed in a teardown from `test/run.ts`). |
| Port conflict on start | Change `PORT` or stop the old node process (`Get-NetTCPConnection -LocalPort <port>`). |
| Login loop / 401 after TLS behind tunnel | Set `BASE_URL=https://...` and `TRUST_PROXY=true`; old `Secure`-not-marked cookies get rejected by browsers (Settings > System shows the effective config). |
| 401 on media in a new tab | Media routes require the session cookie; same-origin only. |

## Python environment

This machine's interpreter is user-site installed:

```powershell
python -m pip show faster-whisper av huggingface_hub opencv-python-headless   # check versions
python -m pip install --user -r requirements.txt                              # repair
```

Restart the node server after Python repairs (the sidecar is a child process per job).
