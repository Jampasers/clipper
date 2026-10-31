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
