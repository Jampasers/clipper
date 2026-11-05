import { q } from './sqlite.js';

export const PROMPT_TASKS = [
  'content_analysis',
  'highlight_detection',
  'clip_scoring',
  'clip_boundary',
  'title_generation',
  'subtitle_analysis',
  'hook_generation',
  'subtitle_plan',
  'music_selection',
  'creative_direction',
  'reference_visual_analysis',
  'reference_classification',
  'feedback_classification',
  'learning_summarization',
  'creative_brief_analysis',
  'design_art_direction',
  'design_layout',
  'design_copywriting',
  'design_asset_planning',
  'design_variants',
  'design_quality_review',
  'design_repair',
] as const;
export type PromptTask = (typeof PROMPT_TASKS)[number];

export const PROMPT_NAMES: Record<PromptTask, string> = {
  content_analysis: 'Content Analysis',
  highlight_detection: 'Highlight Detection',
  clip_scoring: 'Clip Scoring',
  clip_boundary: 'Clip Boundary Optimization',
  title_generation: 'Title Generation',
  subtitle_analysis: 'Subtitle Analysis',
  hook_generation: 'Opening Hook Generation',
  subtitle_plan: 'Subtitle Styling Plan',
  music_selection: 'Background Music Selection',
  creative_direction: 'Creative Direction (EDL)',
  reference_visual_analysis: 'Reference Visual Analysis',
  reference_classification: 'Reference Classification',
  feedback_classification: 'Feedback Classification',
  learning_summarization: 'Learning Summarization',
  creative_brief_analysis: 'Creative Brief Analysis',
  design_art_direction: 'Design Art Direction',
  design_layout: 'Design Layout Planning',
  design_copywriting: 'Design Copywriting',
  design_asset_planning: 'Design Asset Planning',
  design_variants: 'Design Concept Variations',
  design_quality_review: 'Design Quality Review',
  design_repair: 'Design Repair',
};

export const DEFAULT_PROMPTS: Record<PromptTask, string> = {
  content_analysis: `You are an expert short-form video editor analyzing a transcript to find viral-worthy moments.

TRANSCRIPT (segmented with timestamps):
{{transcript}}

Video duration: {{duration}} seconds.

Identify the most interesting moments in this transcript. Look specifically for:
- strong hooks and surprising statements
- controversial or polarizing statements
- emotional moments
- humor and punchlines
- useful insights and unusual facts
- compelling stories and arguments
- curiosity gaps and strong opinions
- satisfying conclusions

Do NOT pick random or bland sections. Only include moments that could stand alone as engaging short-form content.

Respond ONLY with a JSON array:
[
  {
    "start_segment": <index of transcript segment where the moment starts>,
    "end_segment": <index of transcript segment where the moment ends>,
    "type": "hook|surprising|controversial|emotional|humor|insight|story|argument|fact|punchline|conclusion",
    "reason": "1-2 sentences why this moment is compelling"
  }
]

Return at most 12 moments, ordered by how compelling they are. If nothing qualifies, return [].`,
  highlight_detection: `You are an expert short-form video editor. From the transcript and the interesting moments identified below, generate concrete clip candidates.

TRANSCRIPT (segmented with timestamps):
{{transcript}}

INTERESTING MOMENTS (from previous analysis):
{{moments}}

Constraints:
- Each clip must be between {{min_clip_duration}} and {{max_clip_duration}} seconds. Target around {{target_clip_duration}} seconds.
- A clip must make sense on its own: a viewer who knows nothing else must understand it.
- Strong first 3 seconds (hook). Meaningful payoff at the end.
- Start at a sentence boundary; end on a complete thought.
- Write the title, hook, and reason in the SAME LANGUAGE as the transcript (e.g. Indonesian transcript -> Indonesian title).

Respond ONLY with a JSON array of clip candidates:
[
  {
    "start_segment": <index>,
    "end_segment": <index>,
    "title": "punchy title, max 8 words",
    "hook": "the opening line or paraphrased hook that grabs attention",
    "reason": "why this clip will perform well (1-2 sentences)"
  }
]

Return at most {{max_candidates}} candidates, best first. If nothing qualifies, return [].`,
  clip_scoring: `You are a strict short-form content judge. Score this clip candidate (given as a transcript excerpt) on 8 factors, 0-10 each:
hook (instant grab in first 3s), context (understandable standalone), standalone (works without external knowledge), emotion (emotional impact), entertainment (fun/interesting to watch), payoff (satisfying resolution/value), curiosity (makes you want to know more), shareability (would someone send this to a friend).

CLIP TRANSCRIPT:
{{clip_transcript}}

Clip duration: {{clip_duration}} seconds. Working clip title: {{title}}

Be harsh: 5 is average, 8+ is rare. Length {{min_clip_duration}}-{{max_clip_duration}}s is ideal.

Respond ONLY with JSON:
{"hook": 0-10, "context": 0-10, "standalone": 0-10, "emotion": 0-10, "entertainment": 0-10, "payoff": 0-10, "curiosity": 0-10, "shareability": 0-10, "comment": "one-line justification"}`,
  clip_boundary: `You are a video editor refining clip boundaries so the clip starts and ends naturally.

FULL TRANSCRIPT around the clip:
{{context_transcript}}

Current proposed clip: start = {{start}}s, end = {{end}}s.

Rules:
- The clip should start at the beginning of a sentence or a natural conversational turn.
- The clip should end at the end of a complete statement, ideally with a small breather.
- Keep duration within {{min_clip_duration}}-{{max_clip_duration}} seconds.
- Never cut mid-sentence at the start; avoid ending on an unfinished thought.

Respond ONLY with JSON: {"start": <seconds>, "end": <seconds>, "note": "brief reason"}

Allowed range: start in [{{start_min}}, {{start_max}}], end in [{{end_min}}, {{end_max}}].`,
  title_generation: `Write a title and hook for this short-form clip.

TRANSCRIPT:
{{transcript}}

Requirements:
- Write the title and hook in the same language as the transcript (e.g. an Indonesian transcript gets an Indonesian title).
- Title: max 8 words, punchy, no clickbait lies, matches the content.
- Hook: the single most attention-grabbing line (may be quoted verbatim from the transcript).

Respond ONLY with JSON: {"title": "...", "hook": "..."}`,
  subtitle_analysis: `Analyze this transcript excerpt for subtitle emphasis.

TRANSCRIPT:
{{transcript}}

Select up to 8 words or short phrases (per clip) that deserve visual emphasis because they carry the punch, surprise, or key numbers. Use the same language as the transcript.

Respond ONLY with JSON:
{"emphasis": ["word1", "word2"], "notes": "brief note"}`,
  hook_generation: `You are a short-form video editor choosing an opening hook (a 5-8 second teaser) for a clip.

CLIP WINDOW: {{clip_start}}s -> {{clip_end}}s ({{clip_duration}}s long). Target hook duration: {{target_duration}}s (between {{min_duration}} and {{max_duration}} seconds).

NUMBERED WORDS inside the clip (index: text [start-end]s):
{{words}}

CONTEXT BEFORE THE CLIP (do not pick from here, only to understand meaning):
{{context}}

Pick hook candidates that are short teasers moved to the FRONT of the clip. Requirements:
- The candidate is a self-contained intriguing statement, punchline, surprising fact, strong claim or question.
- It must be understandable on its own and must not cut a word or sentence unnaturally.
- Prefer candidates that create curiosity or emotional intensity.
- Use word indexes for exact boundaries (start_word is the first word of the candidate, end_word is the last word, inclusive).
- Never pick words that need the surrounding context to make sense.

Respond ONLY with JSON:
{"candidates": [{"start_word": <index>, "end_word": <index>, "score": 0-100, "reason": "why this hook works"}]}

Return 1-5 candidates, best first. If nothing works as a hook, return {"candidates": []}.`,
  subtitle_plan: `You are an expert subtitle designer for short-form videos. Given the transcript words of a clip, choose which words deserve visual emphasis and how they should look.

WORDS (index: text, grouped per subtitle line; indexes are global):
{{words}}

Rules:
- Never change the text: you only assign style to existing word indexes.
- Highlight only words that truly carry meaning: key nouns/verbs, numbers and amounts, emotional expressions, punchlines, questions, conclusions.
- Do NOT highlight random or filler words. At most 20% of the words, hard cap 40 highlighted words.
- role must be one of: important, number, emotion, punchline, hook, question, conclusion (skip the word entirely if it is just normal).
- Optional overrides: "color" (hex like #FFD400), "scale" (0.9-1.8), "animation" (pop|bounce|fade|slide|shake|none), "priority" (1-10).
- Use the same language as the transcript. Keep emphasis natural: short bursts, not entire sentences.

Respond ONLY with JSON:
{"words": [{"index": 12, "role": "number", "color": "#FFD400", "scale": 1.25, "animation": "pop", "priority": 8}]}`,
  music_selection: `You choose background music for a short-form video clip. Only pick from the provided library — never invent assets.

VIDEO:
- Title: {{title}}
- Clip length: {{clip_duration}}s
- Transcript excerpt: {{transcript}}

MUSIC LIBRARY (id | name | mood | genre | energy 1-5 | bpm):
{{library}}

Decide:
1. Is background music appropriate at all? (No for sensitive/emotional testimonies where music distracts, or when nothing fits.)
2. If yes, pick the single best matching asset id.

Respond ONLY with JSON:
{"use_music": true, "asset_id": "...", "reason": "short reason", "mood": "one-word mood"}`,
  creative_direction: `You are the creative director of a short-form video. You receive analysis data plus a deterministic baseline "creative plan" (an EDL — edit decision list). Improve pacing and on-screen storytelling by editing that JSON plan.

CLIP:
- Title: {{title}}
- Output duration: {{duration}}s (every timestamp below is on this OUTPUT timeline, 0..{{duration}})
- Aspect: {{aspect}}
- Hook zone: {{hook}}
- Scene analysis: {{scene_summary}}
- Speech rate: {{speech_rate}} words/s

TRANSCRIPT EXCERPT (output-timeline timestamps):
{{transcript}}

BASELINE PLAN (this exact JSON shape):
{{baseline}}

B-ROLL LIBRARY (id | name | tags | kind | duration s). Reference with "assetId", or write a short "query" in the transcript's language. Never invent ids that are not listed:
{{broll_library}}

SOUND LIBRARY (id | name | tags | duration s). Only reference listed ids:
{{sfx_library}}

RULES:
- Respond ONLY with one JSON object. Include a field only when you change it; an included array REPLACES the baseline array entirely. Omitted fields keep the baseline value.
- Allowed top-level fields: style, framings, titles, lowerThirds, statCards, callouts, broll, sfx, emphasis, music, audio.
- Timestamps are seconds, start < end, inside [0, {{duration}}]. Graphics last 0.6-6s. At most 1 title (at the start), 4 lower thirds, 3 stat cards, 3 callouts, 20 b-roll placements, 12 sfx, 40 emphasis words.
- Place b-roll only where it genuinely illustrates a phrase, 1-6s each, aligned with its sentence. No match means no b-roll.
- Emphasis words must appear verbatim in the transcript excerpt.
- Do not overlap a title, stat card and callout at the same moment.
- Never output ffmpeg, shell commands, file paths, code or JSX — only the schema fields above.
- Keep it tasteful: fewer, well-timed graphics beat many.`,
  reference_visual_analysis: `You are a professional video editor analysing a reference video so its editing style can be reused as INSPIRATION for future edits. You see sampled frames; you never guess at what is not visible.

REFERENCE:
{{meta}}

DETERMINISTIC MEASUREMENTS (already computed from the file — trust these, never contradict them):
{{measurements}}

SAMPLED FRAMES (each line is one image, in order; you see them as attachments):
{{frames}}

Describe ONLY what the frames actually show. For every field use "unknown" when the frames do not show enough evidence. Do not invent numbers for brightness/contrast/saturation/pacing/cut counts — those come from the measurements above.

Allowed values:
- colorGrade: warm|cool|neutral|high_contrast_warm|high_contrast_cool|desaturated|vivid|cinematic|unknown
- motionGraphics / graphicDensity / framingVariation / zoomFrequency / musicEnergy / sfxDensity / transitionIntensity: very_low|low|medium|medium_high|high|very_high|unknown
- cameraMovement: static|pan|tilt|handheld|zoom|mixed|unknown
- subjectPriority: speaker|subject|product|group|mixed|unknown
- subtitleStyle: none|static|bold_uppercase|karaoke|kinetic|word_by_word|unknown
- highlightMode: none|keyword|semantic|karaoke|unknown
- transitions.preferred: subset of cut|fade|zoom|slide|whip|glitch|other
- hookStructure / introPattern / outroPattern: a short snake_case label or unknown

Respond ONLY with JSON:
{"categories": ["podcast"], "tags": ["two_speakers", "studio_set"],
 "visual": {"colorGrade": "high_contrast_warm", "typography": "bold sans captions or unknown", "motionGraphics": "medium", "overlayPosition": "bottom", "graphicDensity": "low"},
 "camera": {"movement": "static", "zoomFrequency": "medium", "framingVariation": "high", "subjectPriority": "speaker"},
 "subtitles": {"style": "kinetic", "maxWordsPerGroup": 4, "highlightMode": "semantic"},
 "transitions": {"preferred": ["cut", "zoom"], "intensity": "medium"},
 "audio": {"musicEnergy": "medium", "sfxDensity": "low"},
 "editing": {"hookStructure": "cold_open_question", "introPattern": "host_greeting", "outroPattern": "cta"},
 "evidence": ["frame 1: centered host, bold bottom captions"],
 "confidence": 0.0}

maxWordsPerGroup is an integer 1-12 or null. confidence is 0..1. Return 2-5 categories and up to 8 tags. Evidence must reference specific frames by their index. If no frame shows subtitles, use "none"/unknown instead of guessing.`,
  reference_classification: `Classify a reference video for a style library, based on the analysis summary below. Never invent facts that are not in the summary.

SUMMARY:
{{summary}}

Pick 1-4 categories from: podcast, educational, tutorial, vlog, interview, gaming, cinematic, documentary, music, comedy, fitness, tech, news, social, other.
Pick up to 8 lowercase snake_case tags describing content, setting, or style.

Respond ONLY with JSON: {"categories": ["podcast"], "tags": ["two_speakers"]}`,
  feedback_classification: `A user of a video editing tool gave free-form feedback. Map it onto ONE learned style feature when the feedback clearly targets editing style. If it is generic praise/complaint with no specific feature, return feature "none".

FEEDBACK:
{{feedback}}

CLIP CONTEXT:
{{context}}

Features (value type in brackets):
- zoom_intensity [number 0..1], zoom_frequency [very_low|low|medium|medium_high|high|very_high]
- subtitle_style [bold|karaoke|kinetic|minimal|classic|none], subtitle_density [none|low|medium|high]
- color_grade [none|warm|cool|vivid|cinematic], transition_preference [cut|fade|slide]
- broll_density [none|low|medium|high], sfx_density [none|low|medium|high]
- music_intensity [none|low|medium|high], pacing [slow|medium|fast]
- motion_graphics [none|low|medium|high], visual_complexity [low|medium|high]

Sentiment must be positive (user wants MORE of this) or negative (user wants LESS / remove).

Respond ONLY with JSON: {"feature": "zoom_intensity", "sentiment": "negative", "value": 0.1, "reason": "short"}`,
  learning_summarization: `Summarise deterministic learning data into at most 5 short, factual insight sentences for a video editor's memory. Use ONLY the numbers and values below; never invent observations.

LEARNED PREFERENCES:
{{preferences}}

RECENT LEARNING EVENTS:
{{events}}

Each insight must cite the evidence (counts, values, contexts). If there is not enough data for an insight, omit it.

Respond ONLY with JSON: {"insights": ["Users consistently lower zoom intensity in podcast edits (4 events, confidence 0.7)."]}`,

  /* ---------- AI Creative Studio: Design Studio ---------- */

  creative_brief_analysis: `You are a senior graphic designer analysing a creative brief before any layout work. Extract structured requirements. Never invent facts that are not in the brief; use "unspecified" where the brief is silent.

BRIEF:
{{brief}}

FORMAT / CANVAS:
{{format}}

BRAND / REFERENCES (may be empty):
{{brand}}

Respond ONLY with JSON:
{
  "goal": "one sentence purpose of the design",
  "audience": "target audience or unspecified",
  "tone": "3-5 comma separated adjectives",
  "must_include": ["verbatim facts that must appear: prices, dates, addresses, names"],
  "avoid": ["things the design must avoid"],
  "cta": "call to action text or empty",
  "language": "ISO-like language of the brief (en, id, ...)",
  "format_intent": "poster|flyer|banner|thumbnail|social_post|advertisement|invitation|other"
}`,

  design_art_direction: `You are an award-winning art director. Produce ONE concrete art direction for the brief. This is strategy, not the final layout.

BRIEF ANALYSIS:
{{analysis}}

CANVAS: {{width}}x{{height}} ({{orientation}})
STYLE REFERENCES / LEARNED PREFERENCES (may be empty; explicitly requested instructions win):
{{references}}

Rules:
- Choose a composition strategy that suits the content; do not default to centered stacks for everything.
- Color palette must be 3-6 hex colors with real contrast for text.
- typography.scale is a modular scale multiplier between 1.1 and 1.6.
- background must be one of: "solid", "gradient", "image" (image only when an image is needed/allowed).
- image_prompt is a photographic/illustration prompt for a raster background or hero image, or "" when no raster is needed. Never put text, logos, prices or dates in an image prompt.

Respond ONLY with JSON:
{
  "concept": "short name of the creative concept",
  "rationale": "1-2 sentences why this fits the brief",
  "composition": "editorial|minimalist|modern_promo|bold_typography|product_showcase|event_poster|corporate|luxury|social",
  "hierarchy": ["headline", "subheadline", "cta", "details"],
  "palette": ["#0b0d12", "#ffffff", "#6c8cff"],
  "typography": {"heading_family": "Arial Black", "body_family": "Segoe UI", "scale": 1.3, "heading_weight": 800, "uppercase_headline": true},
  "texture": "none|grain|paper|noise|pattern",
  "background": "solid|gradient|image",
  "image_prompt": "",
  "decorative_elements": ["bold rule", "offset frame"],
  "density": "low|medium|high"
}`,

  design_layout: `You are a graphic design layout planner. Place the design's editable blocks on the canvas. The deterministic layout engine will validate and may repair your proposal, so coordinates must be within the canvas.

CANVAS: {{width}}x{{height}}
SAFE AREA: {{safe}}
ART DIRECTION: {{artDirection}}
CONTENT BLOCKS (id | role | text | suggested size):
{{blocks}}

Rules:
- Every block id must appear exactly once.
- x/y are the top-left corner; width/height must be positive and stay inside the safe area where possible.
- Keep a visible margin of at least 4% of the canvas width from every edge.
- Do not overlap text blocks. Intentional overlaps are allowed only for decorative/background shapes.
- Follow the art direction composition; vary alignment and scale.
- alignment is one of left|center|right; anchor is one of top|middle|bottom.

Respond ONLY with JSON:
{"blocks": [{"id": "headline", "x": 80, "y": 120, "width": 920, "height": 240, "alignment": "left", "anchor": "top", "fontScale": 1.0}]}`,

  design_copywriting: `You are a senior copywriter producing the text for one graphic design. Write ONLY the requested blocks, in the brief's language. Keep text short enough for the given canvas: headlines should be readable at a glance, never paragraphs.

BRIEF:
{{brief}}

ART DIRECTION:
{{artDirection}}

BLOCKS TO WRITE (id | role | max characters):
{{blocks}}

Rules:
- Never invent prices, dates, phone numbers, addresses, discount percentages or legal text; use only what the brief states. If the brief does not provide a required fact, leave that block empty.
- The CTA must be short (2-5 words).
- No emoji unless the brief explicitly uses them.

Respond ONLY with JSON:
{"blocks": [{"id": "headline", "text": "..."}], "notes": "optional short note"}`,

  design_asset_planning: `You are planning raster assets for a graphic design. Decide which images genuinely improve the design. The image generator cannot render text, logos, prices or dates.

BRIEF:
{{brief}}

ART DIRECTION:
{{artDirection}}

AVAILABLE LIBRARY ASSETS (may be empty; id | name | tags):
{{library}}

Respond ONLY with JSON:
{
  "needs_background": true,
  "needs_hero_image": false,
  "background_prompt": "photographic prompt, no text",
  "negative_prompt": "text, watermark, logo, extra fingers",
  "library_asset_ids": ["existing-id-to-reuse"],
  "notes": "short"
}`,

  design_variants: `You are an art director generating DISTINCT design concepts, not recolors. For each variation produce a different composition strategy and readable palette.

BRIEF ANALYSIS:
{{analysis}}

CANVAS: {{width}}x{{height}}
COUNT: {{count}}
BASE ART DIRECTION (do not copy it verbatim; diverge):
{{artDirection}}

Rules:
- Every variation must differ in at least one of: composition, hierarchy order, typography scale, palette temperature, background treatment.
- Palettes must keep text/background contrast high.

Respond ONLY with JSON:
{"variants": [{"concept": "...", "composition": "editorial|minimalist|modern_promo|bold_typography|product_showcase|event_poster|corporate|luxury|social", "palette": ["#ffffff"], "typography": {"heading_family": "Arial Black", "body_family": "Segoe UI", "scale": 1.2, "heading_weight": 800, "uppercase_headline": false}, "background": "solid|gradient|image", "density": "low|medium|high", "image_prompt": ""}]}`,

  design_quality_review: `You are a strict design director reviewing a rendered graphic. Score honestly. Only report issues you can see or prove from the geometry data. Never invent layer ids.

DESIGN SUMMARY:
{{summary}}

GEOMETRY (layer id | type | x,y,w,h | text preview):
{{geometry}}

RENDERED DESIGN: attached image (if provided).

Respond ONLY with JSON:
{
  "score": 0-100,
  "hierarchy": "weak|ok|strong",
  "balance": "weak|ok|strong",
  "readability": "weak|ok|strong",
  "brief_compliance": "partial|ok|strong",
  "issues": [{"type": "hierarchy|balance|readability|contrast|density|brief|typography", "severity": "low|medium|high", "layer_id": "optional-layer-id", "description": "specific issue", "suggestion": "specific fix"}]
}`,

  design_repair: `You are repairing a graphic design. Propose ONLY small, safe, whitelisted operations. Never rewrite or delete business-critical text (prices, dates, phone numbers, addresses, legal text, contact info).

DOCUMENT SUMMARY:
{{summary}}

ISSUES:
{{issues}}

ALLOWED OPERATIONS:
- move_layer: {"op":"move_layer","layer_id":"...","x":123,"y":456}
- resize_layer: {"op":"resize_layer","layer_id":"...","width":300,"height":120}
- set_font_size: {"op":"set_font_size","layer_id":"...","font_size":48}
- set_color: {"op":"set_color","layer_id":"...","color":"#ffffff"}
- set_opacity: {"op":"set_opacity","layer_id":"...","opacity":0.9}
- set_alignment: {"op":"set_alignment","layer_id":"...","alignment":"left|center|right"}
- nudge_layer: {"op":"nudge_layer","layer_id":"...","dx":10,"dy":-10}

Respond ONLY with JSON:
{"operations": [...], "reason": "short"}`,
};

export function getPromptRows() {
  return q
    .all<{ id: number; key: string; name: string; text: string; is_default: number; updated_at: string }>(
      'SELECT id, key, name, text, is_default, updated_at FROM prompts ORDER BY id'
    )
    .map((r) => ({ ...r, is_default: !!r.is_default }));
}

export function getPrompt(task: PromptTask): string {
  const row = q.get<{ text: string }>('SELECT text FROM prompts WHERE key = ?', task);
  return row?.text ?? DEFAULT_PROMPTS[task];
}

export function savePrompt(task: PromptTask, text: string) {
  const isDefault = text.trim() === DEFAULT_PROMPTS[task].trim() ? 1 : 0;
  q.run(
    `INSERT INTO prompts (key, name, text, is_default) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET text = excluded.text, is_default = excluded.is_default, updated_at = datetime('now')`,
    task,
    PROMPT_NAMES[task],
    text,
    isDefault
  );
}

export function resetPrompt(task: PromptTask) {
  savePrompt(task, DEFAULT_PROMPTS[task]);
}

export function seedPrompts() {
  for (const task of PROMPT_TASKS) {
    const row = q.get('SELECT id FROM prompts WHERE key = ?', task);
    if (!row) {
      q.run('INSERT INTO prompts (key, name, text, is_default) VALUES (?, ?, ?, 1)', task, PROMPT_NAMES[task], DEFAULT_PROMPTS[task]);
    }
  }
}

/** Render {{variable}} templates. Missing vars become empty strings. */
export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    const v = vars[name];
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

export function promptVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) out.add(m[1]);
  return [...out];
}
