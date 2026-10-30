import 'dotenv/config';
import { initDb } from './lib/sqlite.js';
import { seedPrompts } from './lib/prompts.js';
import { config } from './config.js';
import { logger } from './lib/log.js';
import { createApp } from './app.js';
import { registerWorkers, startWorker } from './workers/worker.js';
import { runHealthChecks } from './lib/health.js';

initDb();
seedPrompts();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info('SYSTEM', `dashboard listening on http://localhost:${config.port}`);
  logger.info('SYSTEM', `storage: ${JSON.stringify(config.dirs)}`);
  registerWorkers();
  startWorker();
  void runHealthChecks().then((h) => {
    for (const item of h.items) {
      if (!item.ok) logger.warn('SYSTEM', `health: ${item.name} — ${item.error ?? item.detail}`);
    }
  });
});

process.on('SIGINT', () => {
  logger.info('SYSTEM', 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
