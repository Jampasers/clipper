import 'dotenv/config';
import { initDb } from '../lib/sqlite.js';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { registerWorkers, startWorker } from '../workers/worker.js';
import { startTelegram } from './bot.js';

initDb();
registerWorkers();
const stopWorker = startWorker();
const stop = startTelegram();
logger.info('TELEGRAM', `bot process started (allowed user: ${config.telegram.allowedUserId || 'NOT SET'})`);

process.on('SIGINT', () => {
  stop();
  stopWorker();
  process.exit(0);
});
