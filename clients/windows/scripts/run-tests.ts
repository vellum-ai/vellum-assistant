/**
 * Runs each test file in a separate Bun process so module mocks cannot leak
 * between files.
 */
import { Glob } from "bun";

const args = process.argv.slice(2);
const concurrency = Math.max(
  1,
  Number.parseInt(process.env.TEST_CONCURRENCY ?? "8", 10) || 8,
);

const files =
  args.length > 0
    ? args
    : [
        ...new Glob("src/**/*.test.ts").scanSync("."),
        ...new Glob("scripts/**/*.test.ts").scanSync("."),
        "../../packages/electron-utils/src/app-protocol.test.ts",
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
    process.stderr.write(`\nFailed: ${file}\n${stdout}${stderr}`);
    return false;
  }
  return true;
}

for (let i = 0; i < files.length; i += concurrency) {
  const batch = files.slice(i, i + concurrency);
  await Promise.all(
    batch.map(async (file) => {
      if (await runFile(file)) {
        passed++;
      } else {
        failed++;
        failures.push(file);
      }
    }),
  );
}

console.log(
  `\n${passed} passed, ${failed} failed (${files.length} test files)`,
);

if (failures.length > 0) {
  console.log("\nFailed test files:");
  for (const file of failures) {
    console.log(`  ${file}`);
  }
  process.exit(1);
}
