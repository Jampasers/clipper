import 'dotenv/config';
import { initDb } from '../src/lib/sqlite.js';
import { seedPrompts } from '../src/lib/prompts.js';
import { ensureSuperAdmin, countUsers } from '../src/lib/auth.js';
import { config } from '../src/config.js';

initDb();
seedPrompts();

if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD is not set in .env. Set it to create the Super Admin.');
  process.exit(1);
}

if (countUsers() > 0) {
  console.log(`Super Admin already exists — keeping the current account. (DB: ${config.dbName})`);
} else {
  const { created } = ensureSuperAdmin(config.adminUsername, config.adminPassword);
  console.log(created ? `Super Admin "${config.adminUsername}" created.` : 'Super Admin exists.');
}
console.log('Database ready:', config.dbName);
console.log('Default prompts seeded.');
process.exit(0);
