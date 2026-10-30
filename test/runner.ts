/* Tiny assertion test runner (no framework). Run: pnpm test */
import fs from 'node:fs';
import path from 'node:path';

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn; only?: boolean }[] = [];

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
export function tonly(name: string, fn: TestFn) {
  tests.push({ name, fn, only: true });
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
export function assertEquals<T>(a: T, b: T, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`assertEquals failed${msg ? ` (${msg})` : ''}\n  actual:   ${sa}\n  expected: ${sb}`);
}
export function assertThrows(fn: () => unknown, msg = '') {
  try {
    fn();
    throw new Error(`expected function to throw${msg ? `: ${msg}` : ''}`);
  } catch (e) {
    if (String((e as Error).message).startsWith('expected function to throw')) throw e;
  }
}
/** fresh isolated DB + storage for a test module */
export function freshEnv(name: string): string {
  const base = fs.mkdtempSync(path.join(process.env.TEMP || 'C:\\Users\\mzida\\AppData\\Local\\Temp', `avc-${name}-`));
  return base;
}

export async function run() {
  const only = tests.filter((t) => t.only);
  const list = only.length ? only : tests;
  let passed = 0, failed = 0;
  const failedNames: string[] = [];
  for (const t of list) {
    process.stdout.write(`\n· ${t.name} `);
    try {
      await t.fn();
      passed++;
      console.log('\x1b[32m✓\x1b[0m');
    } catch (e) {
      failed++;
      failedNames.push(t.name);
      console.log(`\x1b[31m✗\x1b[0m\n  ${(e as Error).message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed${failedNames.length ? ': ' + failedNames.join(', ') : ''}`);
  if (failed > 0) process.exitCode = 1;
}
