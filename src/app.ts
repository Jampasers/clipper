import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { loadSession } from './lib/middleware.js';
import { logger } from './lib/log.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter, mediaRouter, jobsRouter } from './routes/projects.js';
import { clipsApi } from './routes/clips.js';
import { settingsRouter, promptsRouter, systemRouter } from './routes/settings.js';
import { dashboardRouter } from './routes/dashboard.js';
import { runHealthChecks } from './lib/health.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(loadSession);

  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/clips', clipsApi);
  app.use('/api/settings', settingsRouter);
  app.use('/api/prompts', promptsRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/media', mediaRouter);

  app.get('/api/health', async (_req, res) => {
    try {
      res.json(await runHealthChecks());
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err?.status || (err?.message?.includes('File too large') ? 413 : 500);
    logger.error('SYSTEM', `request error: ${err?.message ?? err}`);
    res.status(status).json({ error: String(err?.message ?? 'internal error').slice(0, 500) });
  });

  staticServe(app);
  return app;
}

function staticServe(app: express.Express) {
  const publicDir = path.join(config.root, 'public');
  if (!fs.existsSync(publicDir)) return;
  // SPA assets ship without content hashes: revalidate each load (ETag/304)
  // so updates go live immediately instead of stale-caching for hours.
  app.use(express.static(publicDir, {
    etag: true,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api|media).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}
