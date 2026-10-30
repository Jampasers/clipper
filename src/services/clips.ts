import { nanoid } from 'nanoid';
import { q, J } from '../lib/sqlite.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/log.js';

export interface ClipRow {
  id: string;
  project_id: string;
  ord: number;
  start: number;
  end: number;
  title: string | null;
  hook: string | null;
  reason: string | null;
  scores: string | null;
  overall: number | null;
  status: string;
  aspect: string | null;
  subtitle_preset: string | null;
  boundary: string | null;
  emphasis: string | null;
  created_at: string;
  updated_at: string;
}

export function createClip(input: {
  project_id: string;
  ord: number;
  start: number;
  end: number;
  title?: string;
  hook?: string;
  reason?: string;
  scores?: Record<string, number>;
  overall?: number;
  boundary?: unknown;
}): ClipRow {
  const id = nanoid(10);
  q.run(
    `INSERT INTO clips (id, project_id, ord, start, end, title, hook, reason, scores, overall, boundary)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.project_id,
    input.ord,
    input.start,
    input.end,
    input.title ?? null,
    input.hook ?? null,
    input.reason ?? null,
    input.scores ? JSON.stringify(input.scores) : null,
    input.overall ?? null,
    input.boundary ? JSON.stringify(input.boundary) : null
  );
  return getClip(id)!;
}

export function getClip(id: string): ClipRow | undefined {
  return q.get<ClipRow>('SELECT * FROM clips WHERE id = ?', id);
}

export function listClips(filter: { projectId?: string; status?: string; limit?: number } = {}): ClipRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const sql = `SELECT * FROM clips ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  args.push(filter.limit ?? 200);
  return q.all<ClipRow>(sql, ...args);
}

export function updateClip(id: string, patch: Partial<Record<string, unknown>>) {
  const allowed = ['start', 'end', 'title', 'status', 'aspect', 'subtitle_preset', 'hook', 'reason', 'scores', 'overall', 'boundary', 'emphasis'];
  const sets: string[] = [];
  const args: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (!sets.length) return getClip(id);
  sets.push("updated_at = datetime('now')");
  args.push(id);
  q.run(`UPDATE clips SET ${sets.join(', ')} WHERE id = ?`, ...args);
  return getClip(id);
}

export function rejectClip(id: string) {
  return updateClip(id, { status: 'rejected' });
}

export function deleteClip(id: string) {
  q.run('DELETE FROM clips WHERE id = ?', id);
}

/** Select the best N clips (or explicit ids) and mark them 'selected'. */
export function selectClips(projectId: string, opts: { top?: number; ids?: string[] }) {
  const clips = listClips({ projectId, limit: 1000 }).filter((c) => c.status !== 'rejected');
  let chosen: ClipRow[];
  if (opts.ids && opts.ids.length) {
    chosen = clips.filter((c) => opts.ids!.includes(c.id));
  } else {
    const top = opts.top ?? getSettings('clipping').top_clips;
    chosen = [...clips].sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0)).slice(0, top);
  }
  for (const c of clips) {
    const shouldSelect = chosen.some((x) => x.id === c.id);
    if (shouldSelect && c.status !== 'selected') updateClip(c.id, { status: 'selected' });
    else if (!shouldSelect && c.status === 'selected') updateClip(c.id, { status: 'candidate' });
  }
  logger.info('VIDEO', `project ${projectId}: selected ${chosen.length} clips`);
  return chosen.map((c) => getClip(c.id)!);
}

export function clipView(c: ClipRow) {
  return {
    ...c,
    scores: J.read<Record<string, number>>(c.scores) ?? {},
    boundary: J.read(c.boundary ?? null),
    emphasis: J.read<string[]>(c.emphasis) ?? [],
    duration: Math.round((c.end - c.start) * 100) / 100,
  };
}

export function replaceProjectClips(projectId: string, candidates: {
  start: number; end: number; title: string; hook: string; reason: string;
  scores: Record<string, number>; overall: number; boundary?: unknown;
}[]) {
  q.run("DELETE FROM clips WHERE project_id = ? AND status IN ('candidate','selected')", projectId);
  return candidates.map((c, i) =>
    createClip({
      project_id: projectId,
      ord: i + 1,
      start: c.start,
      end: c.end,
      title: c.title,
      hook: c.hook,
      reason: c.reason,
      scores: c.scores,
      overall: c.overall,
      boundary: c.boundary,
    })
  );
}
