import { q } from './sqlite.js';

export const PROMPT_TASKS = [
  'content_analysis',
  'highlight_detection',
  'clip_scoring',
  'clip_boundary',
  'title_generation',
  'subtitle_analysis',
] as const;
export type PromptTask = (typeof PROMPT_TASKS)[number];

export const PROMPT_NAMES: Record<PromptTask, string> = {
  content_analysis: 'Content Analysis',
  highlight_detection: 'Highlight Detection',
  clip_scoring: 'Clip Scoring',
  clip_boundary: 'Clip Boundary Optimization',
  title_generation: 'Title Generation',
  subtitle_analysis: 'Subtitle Analysis',
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
