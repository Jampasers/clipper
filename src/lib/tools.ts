import { z } from 'zod';

/**
 * CONTROLLED TOOL LAYER.
 *
 * AI output may only ever produce *tool calls* — never shell commands, never
 * file paths, never raw SQL. Every known operation is declared here with a
 * strict zod schema. Unknown operations are rejected. All values are validated
 * before any function runs.
 *
 * This is the only place where AI requests are translated into real work.
 */

export const TOOL_SCHEMAS = {
  probe_video: z.object({ project_id: z.string().min(1) }),
  transcribe: z.object({ project_id: z.string().min(1), language: z.string().optional() }),
  analyze_transcript: z.object({ project_id: z.string().min(1) }),
  generate_clip: z.object({
    project_id: z.string().min(1),
    start: z.number().min(0),
    end: z.number().min(0),
    title: z.string().max(120).optional(),
  }),
  render_preview: z.object({ clip_id: z.string().min(1), aspect: z.enum(['9:16', '1:1', '16:9']).optional() }),
  render_final: z.object({ clip_id: z.string().min(1), aspect: z.enum(['9:16', '1:1', '16:9']).optional() }),
  generate_subtitles: z.object({ clip_id: z.string().min(1), format: z.enum(['srt', 'ass']).default('ass') }),
  reframe_video: z.object({
    clip_id: z.string().min(1),
    aspect: z.enum(['9:16', '1:1', '16:9']),
  }),
  list_project_files: z.object({ project_id: z.string().min(1) }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
}

export type ValidationResult =
  | { ok: true; tool: ToolName; args: Record<string, unknown> }
  | { ok: false; error: string };

export function validateToolCall(name: string, args: unknown): ValidationResult {
  if (!isToolName(name)) return { ok: false, error: `Unknown or disallowed operation "${name}".` };
  const parsed = TOOL_SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `Invalid arguments for ${name}: ${first.path.join('.') || '(root)'} ${first.message}` };
  }
  return { ok: true, tool: name, args: parsed.data as Record<string, unknown> };
}

/* ---------- Structured edit operations (AI re-edit command) ---------- */

export const EDIT_OP_KINDS = [
  'shift_start',
  'shift_end',
  'snap_start_to_next_sentence',
  'snap_end_to_prev_sentence',
  'remove_first_sentence',
  'set_aspect',
  'set_subtitle_preset',
  'set_title',
  'focus_speaker',
  'emphasize_words',
] as const;

export type EditOpKind = (typeof EDIT_OP_KINDS)[number];

export const EDIT_OP_SCHEMAS = {
  shift_start: z.object({ delta: z.number().min(-120).max(120) }),
  shift_end: z.object({ delta: z.number().min(-120).max(120) }),
  snap_start_to_next_sentence: z.object({}),
  snap_end_to_prev_sentence: z.object({}),
  remove_first_sentence: z.object({}),
  set_aspect: z.object({ aspect: z.enum(['9:16', '1:1', '16:9']) }),
  set_subtitle_preset: z.object({ preset: z.string().min(1).max(40) }),
  set_title: z.object({ title: z.string().min(1).max(120) }),
  focus_speaker: z.object({ enabled: z.boolean() }),
  emphasize_words: z.object({ words: z.array(z.string().min(1).max(60)).max(20) }),
} as const;

export interface EditOp {
  kind: EditOpKind;
  [key: string]: unknown;
}

export type EditOpValidation =
  | { ok: true; ops: EditOp[] }
  | { ok: false; error: string };

export function isEditOpKind(kind: string): kind is EditOpKind {
  return (EDIT_OP_KINDS as readonly string[]).includes(kind);
}

export function validateEditOps(ops: unknown): EditOpValidation {
  if (!Array.isArray(ops)) return { ok: false, error: 'Edit operations must be an array.' };
  if (ops.length === 0) return { ok: false, error: 'No edit operations provided.' };
  if (ops.length > 12) return { ok: false, error: 'Too many edit operations (max 12).' };
  const valid: EditOp[] = [];
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Each operation must be an object.' };
    const op = raw as Record<string, unknown>;
    const kind = op.kind ?? op.op ?? op.operation;
    if (typeof kind !== 'string' || !isEditOpKind(kind)) {
      return { ok: false, error: `Disallowed edit operation "${String(kind)}".` };
    }
    const { kind: _k, op: _o, operation: _op, ...rest } = op;
    const parsed = EDIT_OP_SCHEMAS[kind].safeParse(rest);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, error: `Invalid arguments for ${kind}: ${first.path.join('.') || '(root)'} ${first.message}` };
    }
    valid.push({ kind, ...(parsed.data as Record<string, unknown>) });
  }
  return { ok: true, ops: valid };
}
