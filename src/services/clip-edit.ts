import { chat } from '../lib/ai.js';
import { validateEditOps, type EditOp } from '../lib/tools.js';
import { getSettings, maskApiKey } from '../lib/settings.js';
import { getClip, updateClip, clipView } from './clips.js';
import { getProject, getProjectMeta, ensureProbe } from './projects.js';
import { loadTranscript, type TranscriptSegment } from './transcribe.js';
import { snapStart, snapEnd, removeFirstSentence, segmentIndexAt } from './boundary.js';
import { logger } from '../lib/log.js';

/**
 * AI re-edit: natural-language instruction -> validated structured ops ->
 * applied locally. The AI can only emit ops from EDIT_OP_KINDS; everything
 * else is rejected. No shell, no arbitrary writes.
 */

export interface AiEditOutcome {
  ok: boolean;
  ops: EditOp[] | null;
  note: string;
  clip: ReturnType<typeof clipView> | null;
}

const OPS_REFERENCE: string[] = [
  'shift_start: {"delta": number}  // move start by seconds, negative = earlier',
  'shift_end: {"delta": number}',
  'snap_start_to_next_sentence: {}',
  'snap_end_to_prev_sentence: {}',
  'remove_first_sentence: {}',
  'set_aspect: {"aspect": "9:16"|"1:1"|"16:9"}',
  'set_subtitle_preset: {"preset": string}',
  'set_title: {"title": string}',
  'focus_speaker: {"enabled": boolean}',
  'emphasize_words: {"words": string[]}',
];

export function editInstructionSystemPrompt(duration: number): string {
  return `You convert a user's edit instruction for a video clip into structured operations.
Video duration: ${duration.toFixed(1)} seconds.
The clip time is in seconds (floats). Allowed operations (strict JSON, no extra fields):
${OPS_REFERENCE.map((s) => `- ${s}`).join('\n')}
Return ONLY a JSON object: {"ops": [ {"kind": "...", ...args} ]}.
Map vague requests sensibly ("a bit earlier" -> shift_start with delta around -2; "remove the first sentence" -> remove_first_sentence; "vertical" -> set_aspect 9:16; "make subtitles bigger" is NOT an operation — say so in "note").
If the instruction is not actionable, return {"ops": [], "note": "why not"}. Never invent operations outside the list. You may also include "note": "..." at top level.`;
}

export async function aiParseEditInstruction(clip: { id: string; start: number; end: number; title: string | null }, instruction: string, videoDuration: number): Promise<{ ops: EditOp[] | null; note: string }> {
  const ai = getSettings('ai');
  const model = ai.default_model;
  const user = `Current clip: start=${clip.start.toFixed(2)}s end=${clip.end.toFixed(2)}s title="${clip.title ?? ''}"\nInstruction: ${instruction}\nReturn the JSON now.`;
  let raw = '';
  try {
    const res = await chat('ai_edit', model, [
      { role: 'system', content: editInstructionSystemPrompt(videoDuration) },
      { role: 'user', content: user },
    ]);
    raw = res.raw;
  } catch (err: any) {
    throw new Error(`9Router request failed: ${String(err?.message).slice(0, 200)}`);
  }
  let parsed: { ops?: unknown; note?: string } = { ops: [] };
  try {
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const text = (m ? m[1] : raw).trim();
    const start = text.search(/[[{]/);
    parsed = JSON.parse(start === -1 ? text : text.slice(start));
  } catch (err: any) {
    return { ops: null, note: `Could not parse AI response as JSON: ${raw.slice(0, 200)}` };
  }
  const validation = validateEditOps(parsed.ops);
  const note = typeof parsed.note === 'string' && parsed.note ? parsed.note : '';
  if (!validation.ok) return { ops: null, note: note ? `${note} — ${validation.error}` : validation.error };
  return { ops: validation.ops, note };
}

export function applyEditOps(projectId: string, clipId: string, ops: EditOp[]): { clip: any; changes: string[] } {
  const clip = getClip(clipId)!;
  const transcript = loadTranscript(projectId);
  const segments: TranscriptSegment[] = transcript?.segments ?? [];
  const project = getProject(projectId)!;
  const meta = getProjectMeta(project);
  const duration = meta?.duration ?? Infinity;
  const changes: string[] = [];
  let patch: Record<string, unknown> = {};

  for (const op of ops) {
    switch (op.kind) {
      case 'shift_start': {
        const delta = Number(op.delta);
        let ns = clip.start + delta;
        ns = Math.max(0, Math.min(duration - 5, ns));
        if (clip.end - ns < 5) ns = clip.end - 5;
        patch.start = Math.round(ns * 100) / 100;
        changes.push(`start shifted ${delta >= 0 ? '+' : ''}${delta}s -> ${patch.start}s`);
        break;
      }
      case 'shift_end': {
        const delta = Number(op.delta);
        let ne = clip.end + delta;
        ne = Math.min(duration, Math.max(clip.start + 5, ne));
        patch.end = Math.round(ne * 100) / 100;
        changes.push(`end shifted ${delta >= 0 ? '+' : ''}${delta}s -> ${patch.end}s`);
        break;
      }
      case 'snap_start_to_next_sentence': {
        if (!segments.length) { changes.push('no transcript to snap against'); break; }
        const ns = snapStart(segments, clip.start);
        patch.start = Math.round(ns * 100) / 100;
        changes.push(`start snapped to ${ns.toFixed(2)}s`);
        break;
      }
      case 'snap_end_to_prev_sentence': {
        if (!segments.length) { changes.push('no transcript to snap against'); break; }
        const ne = snapEnd(segments, clip.end);
        patch.end = Math.round(ne * 100) / 100;
        changes.push(`end snapped to ${ne.toFixed(2)}s`);
        break;
      }
      case 'remove_first_sentence': {
        if (!segments.length) { changes.push('no transcript available'); break; }
        const ns = removeFirstSentence(segments, clip.start);
        patch.start = Math.round(ns * 100) / 100;
        changes.push(`first sentence removed, start -> ${ns.toFixed(2)}s`);
        break;
      }
      case 'set_aspect': {
        patch.aspect = op.aspect;
        changes.push(`aspect -> ${op.aspect}`);
        break;
      }
      case 'set_subtitle_preset': {
        const presetName = String(op.preset);
        const sub = getSettings('subtitles');
        if (!sub.presets[presetName]) { changes.push(`unknown preset "${presetName}" — ignored`); break; }
        patch.subtitle_preset = presetName;
        changes.push(`subtitle preset -> ${presetName}`);
        break;
      }
      case 'set_title': {
        patch.title = String(op.title).slice(0, 120);
        changes.push(`title -> "${patch.title}"`);
        break;
      }
      case 'focus_speaker': {
        const b = clip.boundary ? JSON.parse(clip.boundary) : {};
        b.focus_speaker = !!op.enabled;
        patch.boundary = b;
        changes.push(`speaker focus ${op.enabled ? 'enabled' : 'disabled'}`);
        break;
      }
      case 'emphasize_words': {
        const words = Array.isArray(op.words) ? op.words.map(String) : [];
        patch.emphasis = JSON.stringify(words.map((w) => w).slice(0, 20));
        changes.push(`emphasis words: ${patch.emphasis}`);
        break;
      }
    }
  }

  // keep the window sane after shifts
  const finalStart = (patch.start as number) ?? clip.start;
  const finalEnd = (patch.end as number) ?? clip.end;
  if (finalEnd - finalStart < 5) patch.end = finalStart + 5;
  if (finalEnd - finalStart > 300) patch.end = finalStart + 300;

  const updated = updateClip(clipId, patch);
  logger.info('AI', `clip ${clipId} edited: ${changes.join('; ') || 'no changes'}`);
  return { clip: clipView(updated!), changes };
}

/** Public entry used by routes + tests. */
export async function aiEditClip(clipId: string, instruction: string): Promise<AiEditOutcome> {
  const clip0 = getClip(clipId);
  if (!clip0) return { ok: false, ops: null, note: 'clip not found', clip: null };
  const project = getProject(clip0.project_id)!;
  const probe = (project.meta ? JSON.parse(project.meta) : (await ensureProbe(clip0.project_id))) as { duration?: number };
  const { ops, note } = await aiParseEditInstruction(
    { id: clip0.id, start: clip0.start, end: clip0.end, title: clip0.title },
    instruction,
    probe.duration ?? 0
  );
  if (!ops) return { ok: false, ops: null, note, clip: clipView(clip0) };
  const { clip, changes } = applyEditOps(clip0.project_id, clipId, ops);
  return { ok: true, ops, note: note || changes.join('; '), clip };
}

export { maskApiKey };
