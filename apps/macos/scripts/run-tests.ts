/**
 * Runs each test file in its own Bun subprocess to guarantee mock isolation.
 *
 * Bun's `mock.module()` mutates a process-global module registry, so mocks
 * set in one test file leak into every subsequent file in the same process.
 * Running each file in its own process is the only reliable workaround.
 *
 * Mirrors `apps/web/scripts/run-tests.ts` — kept as a per-package copy
 * (rather than a shared workspace script) because each package's `src/`
 * glob and `cwd` differ, and copy is cheaper than the abstraction today.
 *
 * Usage:
 *   bun scripts/run-tests.ts                  # run all test files
 *   bun scripts/run-tests.ts src/foo.test.ts  # run specific files
 *
 * Environment:
 *   TEST_CONCURRENCY=N  — max parallel processes (default: 8)
 *
 * Reference: https://bun.sh/docs/test/mocking#mock-module
 */

import { Glob } from "bun";

const args = process.argv.slice(2);
const concurrency = Math.max(
  1,
  parseInt(process.env.TEST_CONCURRENCY ?? "8", 10) || 8,
);

const files =
  args.length > 0
    ? args
    : [
        ...new Glob("src/**/*.test.ts").scanSync("."),
        ...new Glob("scripts/**/*.test.js").scanSync("."),
        ...new Glob("scripts/**/*.test.ts").scanSync("."),
      ].sort();

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runFile(file: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test", file], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir + "/..",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    process.stderr.write(`\n✗ ${file}\n${stdout}${stderr}`);
    return false;
  }
  return true;
}

for (let i = 0; i < files.length; i += concurrency) {
  const batch = files.slice(i, i + concurrency);
  await Promise.all(
    batch.map(async (f) => {
      if (await runFile(f)) {
        passed++;
      } else {
        failed++;
        failures.push(f);
      }
    }),
  );
}

console.log(`\n${passed} passed, ${failed} failed (${files.length} test files)`);

if (failures.length > 0) {
  console.log("\nFailed:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
