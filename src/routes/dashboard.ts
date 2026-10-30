import { Router } from 'express';
import { requireAuth } from '../lib/middleware.js';
import { q } from '../lib/sqlite.js';
import { listProjects } from '../services/projects.js';
import { listClips } from '../services/clips.js';
import { queueStats } from '../lib/queue.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get('/', (_req, res) => {
  const projects = q.all<{ status: string }>('SELECT status FROM projects');
  const byStatus: Record<string, number> = {};
  for (const p of projects) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const failed = q.all<{ id: string; type: string; project_id: string | null; error: string; created_at: string }>(
    "SELECT id, type, project_id, error, created_at FROM jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5"
  );
  const clips = listClips({ limit: 1000 });
  res.json({
    counts: {
      projects: projects.length,
      projectsByStatus: byStatus,
      clips: clips.length,
      selected: clips.filter((c) => c.status === 'selected').length,
      rendered: listClips({ limit: 1000 }).filter((c) => c.status === 'rendered_final').length,
    },
    recentProjects: listProjects(5).map((p) => ({ id: p.id, name: p.name, status: p.status, created_at: p.created_at })),
    recentFailedJobs: failed,
    queue: queueStats(),
  });
});
