# Visual Learning (reference library + preference engine)

You upload reference videos (your own best-performing edits). The system measures
them locally, looks at sampled frames with a vision model, stores a versioned
style profile, and distills a **preference set** that steers every later
adaptive render. It also learns from your explicit actions (manual settings,
👍/👎 feedback, edits, rejects) and from render outcomes.

Determinism rule: all numbers come from local FFmpeg measurements; the vision
model only describes what it sees in the sampled frames. The learning engine
writes preferences from **validated events only** — an AI classification can
propose a feature change but never write a preference directly.

## Flow

```
upload OR link import (YouTube/TikTok/Instagram via yt-dlp -> reference_download job)
      -> ffprobe -> permanent library dir (source.mp4 + thumbnail + metadata.json)
analysis -> measurements (signalstats/ebur128/silencedetect) + smart frame sampling
            -> vision pass (reference_visual_analysis) + text classification
            -> StyleProfile v1 persisted in reference_analyses (partial if vision is down)
batch job learning_update -> learning_events aggregate -> learning_preferences
            (full recompute, deterministic: explicit weight 2, implicit 1)
render (adaptive) -> reject @ /feedback / PATCH / re-render -> learning_events
            -> reference_usage + learning_experience -> fingerprints invalidate the plan cache
```

## Modules

| Module | Role |
| --- | --- |
| `src/services/reference-library.ts` | CRUD, import (file/link), probe, thumbnail, metadata.json, dirs |
| `src/services/reference-analysis.ts` | measurements, smart sampling, vision, classification, profile persistence |
| `src/services/style-profile.ts` | StyleProfile v1 schema, tier helpers, confidence |
| `src/services/reference-retrieval.ts` | scoring (content/style/preference/visual/history), feature selection, adaptive constraints, VisualLearningContext |
| `src/services/learning.ts` | events (dedupe), deterministic aggregation, preferences, snapshots, experience memory, fingerprint |
| `src/services/reference-jobs.ts` | queue handlers `reference_analysis` + `learning_update` (auto-analyze, coalesced) |
| `src/services/creative-director.ts` | injects the learning context; applies constraints deterministically with provenance |
| `src/services/quality-review.ts` | EDL checks for the learned caps (zoom repetition, subtitle readability, clutter, b-roll/SFX density) |

## Preference features

Numeric/tier/categorical: `zoom_frequency`, `zoom_intensity`, `broll_density`,
`sfx_density`, `motion_graphics`, `subtitle_density`, `subtitle_style`,
`color_grade`, `transition_preference`, `pacing`, `music_intensity`,
`visual_complexity`.

Confidence = consistency × coverage (`min(1, totalWeight / 4)`); below
`min_preference_confidence` a learned value is ignored. **Manual values always
win** over learned ones; a per-context value always wins over the global value.
Context keys are deterministic (`gaming`, `podcast`, `interview`, `educational`,
`tutorial`, `cinematic`, `fitness`, `tech`, `comedy`, `music`, `news`, `vlog`,
`social`) detected from title/transcript/category.

## Settings

`learning` group (Settings > Learning, or `/api/settings/learning`):
- `enabled` (master switch), `auto_analyze` (analyze uploads automatically)
- `use_references`, `max_references` (3), `min_reference_score` (0.15)
- `weights` per scoring term, `min_preference_confidence` (0.25)
- `explicit_weight` (2), `implicit_weight` (1)
- vision caps: `vision_max_frames` (12), `vision_frame_width` (512),
  `max_reference_duration` (45 min), `max_reference_bytes` (600 MB)
- `ai.vision_model`: force a specific vision model ('' = the task route)

## How references change the edit

Two independent channels:

1. **AI context** — the top-scored references (max `max_references`) are injected
   into the Creative Director prompt as style inspiration (never templates).
2. **Reference consensus** — when a strict majority (>= 2 and > half) of the
   selected references agree on a deterministically applicable feature
   (`zoom_frequency`, `motion_graphics`, `color_grade`, `music_intensity`,
   `sfx_density`, `transition_preference`, `subtitle_style`, `overlay_position`),
   the majority value becomes a *soft default*: bounded caps, grade, music
   level, transition type, a framing floor (punch-in rhythm), an SFX baseline
   at cut points, and title/text placement applied to the EDL. When the render
   style is left on "auto", the subtitle style (bold/karaoke/kinetic) is also
   applied at render time. Priority is **manual > learned > reference
   consensus**, so any learned or manual preference for the same feature
   silently overrides it. Applied targets are listed in
   `visualLearning.consensus` and the plan notes.

References alone never force effects a scene cannot support (grade conflicts with
scene brightness are skipped; deterministically added framings/SFX stay inside
the schema and the timeline). Learned preferences (from likes/manual
edits/feedback) always beat the reference pool.

## HTTP + Telegram

- `GET/POST /api/references`, `POST /api/references/url` (link import),
  `GET/PATCH/DELETE /api/references/:id`,
  `POST /api/references/:id/analyze`, `GET /api/references/:id/thumbnail|source`
- `GET /api/learning/preferences|insights|stats|events|history|snapshots`,
  `POST /api/learning/update|reset`, `PUT/PATCH/DELETE /api/learning/preferences`,
  `POST /api/learning/snapshots|snapshots/:id/restore`
- `POST /api/clips/:id/feedback` — `{ rating: 'good'|'bad', notes? }`
- Telegram: `/references`, `/learn`, `/feedback <#|id> <good|bad> [notes]`

## Safety

- Every preference mutation snapshots the previous state first; restore is one click.
- `learning_update` is debounced (one queued job at a time) and recomputes fully
  from retained events — no drift from partial updates.
- The adaptive plan hash includes a learning fingerprint, so learned changes
  invalidate cached plans; `basic` mode is never affected.
- Reference files live in `REFERENCE_DIR`; deleting a reference removes its
  directory. Temporary analysis frames are always cleaned up.
