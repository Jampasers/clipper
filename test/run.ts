/* Test entry: shared env -> unit -> api -> e2e -> run. */
import './env.js';
import { run } from './runner.js';

async function main() {
  const arg = process.argv[2] ?? 'all';
  const teardown: (() => Promise<void>)[] = [];

  if (arg === 'all' || arg === 'unit') {
    await import('./unit.test.js');
    await import('./editing.test.js');
    await import('./creative.test.js');
  }

  if (arg === 'all' || arg === 'api') {
    const mod = await import('./api.test.js');
    teardown.push(await mod.runApiTests());
  }

  if (arg === 'all' || arg === 'e2e') {
    const mod = await import('./e2e.test.js');
    await mod.runE2E();
    const ri = await import('./render-integration.test.js');
    await ri.registerRenderIntegration();
  }

  await run();
  for (const fn of teardown) await fn();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('\nRUNNER CRASH:', e);
  process.exit(1);
});
