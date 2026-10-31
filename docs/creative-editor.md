# AI Creative Editor (adaptive mode)

Adaptive rendering upgrades clips with a Creative Director AI plan, validated
into a strict JSON EDL, then compiled by our own builders into FFmpeg/Remotion
inputs. The AI never emits commands, filters or JSX — only data. `basic` mode
renders exactly as before.

## Flow

```
scene analysis (ffmpeg signalstats/scene/blackdetect + face samples, cached in the editing plan)
        |
adaptive style engine (deterministic: grade, punch-in, blur-fill, transition, edge fades, progress bar)
        |
Creative Director (AI task `creative_direction` -> JSON EDL fragment over the baseline EDL)
        |   \-- any AI failure / invalid fragment -> deterministic baseline EDL (never throws)
        v
static quality review  --problems--> bounded repairEdl (drop/attenuate only)
        v
Remotion CreativeOverlay (ProRes 4444): captions + titles/lower-thirds/stat cards/callouts/progress bar
        |
render-graph single FFmpeg pass: timeline pan, punch-in zoom (eval=frame),
blur-fill, b-roll (cover|pip, alpha fades), xfade/slide, grade, voice cleanup,
BGM + SFX ducking mix, edge fades
        v
media review (blackdetect) -> one bounded re-encode, then flagged in the summary
```

## Modules

| Module | Role |
| --- | --- |
| `src/services/scene-analysis.ts` | brightness / scene cuts / black spans / face samples per clip window |
| `src/services/edl.ts` | EDL zod schema, validation+clamping, zoom curve, overlay layout & collisions, bounded repair, deterministic fallback |
| `src/services/adaptive-style.ts` | signal -> style profile (grade presets -> ffmpeg filters) |
| `src/services/creative-director.ts` | builds typed context, calls the LLM, merges a validated fragment into the baseline EDL |
| `src/services/broll.ts` / `sfx.ts` | asset libraries, relevance scoring, resolution to render specs |
| `src/services/quality-review.ts` | static EDL review (pre-render) + post-render black-frame review |
| `src/services/render-graph.ts` | single-pass FFmpeg graph incl. zoom/grade/b-roll/SFX stages |
| `remotion/CreativeOverlay.tsx` | graphics composition embedding `CaptionOverlay` |

## Settings

`creative` settings group (Settings > AI in the dashboard, or `/api/settings/creative`):
- `mode`: `adaptive` (default) or `basic`
- `quality_review`: static + media review with bounded repair (default on)
- `graphics`: render the Remotion graphics overlay (default on)

Built-in presets `clean` and `minimal` force `basic`.

## HTTP + Telegram

- `GET/POST /api/assets/broll`, `GET/PATCH/DELETE /api/assets/broll/:id`
- `GET/POST /api/assets/sfx`, `GET/PATCH/DELETE /api/assets/sfx/:id`
- Telegram: `/creative` (and `/config`) shows the defaults; the ⚙️ Tune menu has
  🧠 Creative (adaptive/basic) and 🔍 QA (on/off) toggles per render.

## EDL (v1) summary

`aspectRatio`, `style { grade, backgroundFill, punchIn, transition, edgeFade,
progressBar, accentColor }`, `framings[]` (shot sizes -> zoom curve),
`titles/lowerThirds/statCards/callouts[]` (Remotion graphics, laid out in bands
and collision-checked), `broll[]` (assetId or query, cover|pip), `sfx[]`
(libraryId, at, volumeDb), `emphasis[]` (verbatim transcript words + role),
`music`, `audio { cleanup, ducking }`.

Validation clamps all windows to the output duration, dedupes emphasis, drops
unknown asset ids, caps PiP at 4 and SFX at 12, and repairs via `repairEdl`
which can only drop/move/attenuate creative items.

## Testing

- `pnpm test:unit` — EDL, style engine, scene parsers, director merge, graph builders, review.
- `pnpm test:api` — asset routes + settings + auth.
- `pnpm test:e2e` — live pipeline + real-FFmpeg adaptive renders (zoom/grade/b-roll/SFX
  verified by decoding output frames), Remotion overlay with cached Chrome Headless Shell.
