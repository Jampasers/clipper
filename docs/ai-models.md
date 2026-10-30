# AI models

All LLM work goes through one OpenAI-compatible client (`src/lib/ai.ts`) pointed at
`ai.base_url` (default `http://localhost:20128/v1`). Model names are whatever your router
exposes — the `/v1/models` list is available in Settings > AI ("load models") and via
`GET /api/settings/ai/models`.

## Task routing

Each pipeline stage asks for a *task*; `ai.routing[task]` picks the model (falling back to
`ai.default_model`):

| Task | Used for |
| --- | --- |
| `content_analysis` | Find notable moments in the transcript. |
| `highlight_detection` | Propose candidate clips (start/end segments, title, hook, reason). |
| `clip_scoring` | Score a candidate 0–100 on hook/retention/emotion/clarity/payoff. |
| `clip_boundary` | Nudge clip boundaries to the cleanest sentence edges. |
| `title_generation` | Produce a short, catchy title for a clip. |
| `subtitle_analysis` | Pick emphasis words per clip. |
| `chat` (edit) | Natural-language clip edits from the dashboard. |

You can point cheap/fast tasks at a small model and keep a stronger model for scoring, or
run everything on one default. `fallback_model` is used if the routed model errors.

## Relevant settings

- `temperature`, `max_tokens`, `timeout_ms`, `request_retries`.
- `base_url`, `api_key` (masked as `****1234` in API responses; sending the masked value
  back keeps the stored key).

## Reliability

- Transport errors retry on `429` and `5xx` (up to `request_retries`).
- Malformed/truncated JSON retries on the same model (up to 4 attempts), then the
  `fallback_model`, then fails the job (which the queue can retry).
- `extractJson` strips code fences and **repairs truncated JSON**: if the model stops
  mid-array (happens with some streaming/flash models), it closes open strings/brackets and
  drops the incomplete trailing element instead of throwing.
- `401`/`403` (bad key) is not retried — fix the key in Settings > AI.

## Prompts

Prompts live in the `prompts` table, seeded from `DEFAULT_PROMPTS` (`src/lib/prompts.ts`).
Every prompt declares `{{variable}}` placeholders filled by the pipeline (transcript,
duration, candidate window, etc.). Edit, test against a live model, and reset from
Settings > Prompts (`GET/PUT /api/prompts/:task`, `POST /api/prompts/:task/test`,
`POST /api/prompts/:task/reset`).

## The safety boundary

The model is treated as untrusted output:

- It must return **structured JSON**; that is the only shape the pipeline accepts.
- The chat-edit path can only emit operations from a fixed whitelist
  (`set_aspect`, subtitle preset, boundary changes, emphasis, reject, …) validated in
  `src/lib/tools.ts`. Unknown operations are rejected.
- There is **no shell, filesystem, network, or eval** capability reachable from model output.

## Choosing models

- Flash/small models are fast and cheap — good defaults for `content_analysis` and
  `title_generation`.
- Larger models give more consistent JSON and better scoring — use for `clip_scoring` and
  `highlight_detection` if you see parse retries in the logs (Settings > Logs, tag `AI`).
