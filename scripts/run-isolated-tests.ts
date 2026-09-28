import { availableParallelism } from "node:os";

import { Glob } from "bun";

export interface IsolatedTestOptions {
  cwd: string;
  patterns: string[];
  extraFiles?: string[];
}

export async function runIsolatedTests({
  cwd,
  patterns,
  extraFiles = [],
}: IsolatedTestOptions): Promise<void> {
  const args = process.argv.slice(2);
  // Timing-sensitive suites (real timers, `waitFor` deadlines) fail once the
  // cores are saturated, so the default leaves half of them free.
  const defaultConcurrency = Math.min(
    8,
    Math.max(2, Math.floor(availableParallelism() / 2)),
  );
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.TEST_CONCURRENCY ?? "", 10) ||
      defaultConcurrency,
  );
  const shard = parseShard(process.env.TEST_SHARD);
  const allFiles =
    args.length > 0
      ? args
      : [
          // `dot` is off by default, and the walker skips dot-directories even
          // when a pattern spells one out, so suites under `.storybook/` need
          // it on to be found at all.
          // https://bun.sh/docs/api/glob#scan
          ...patterns.flatMap((pattern) => [
            ...new Glob(pattern).scanSync({ cwd, dot: true }),
          ]),
          ...extraFiles,
        ].sort();
  const files = shard
    ? allFiles.filter((_, index) => index % shard.total === shard.index - 1)
    : allFiles;

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  async function runFile(file: string): Promise<boolean> {
    // `bun test` reads a bare argument as a filename filter, and a filter never
    // matches a path under a dot-directory, so every file is passed as an
    // explicit relative path.
    // https://bun.sh/docs/cli/test#run-specific-tests
    const path =
      file.startsWith("./") || file.startsWith("/") ? file : `./${file}`;
    const proc = Bun.spawn(["bun", "test", path], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
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

  // A rolling pool keeps every slot busy, so a slow file occupies only its own
  // slot while the others keep pulling work.
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next++];
      if (await runFile(file)) {
        passed++;
      } else {
        failed++;
        failures.push(file);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );

  console.log(
    `\n${passed} passed, ${failed} failed (${files.length} test files${
      shard ? `, shard ${shard.index}/${shard.total}` : ""
    })`,
  );

  if (failures.length > 0) {
    console.log("\nFailed test files:");
    for (const file of failures) {
      console.log(`  ${file}`);
    }
    process.exit(1);
  }
}

/**
 * Parses `TEST_SHARD=<index>/<total>` (1-based), which splits the sorted file
 * list round-robin so CI can fan one suite out across parallel jobs.
 */
function parseShard(
  value: string | undefined,
): { index: number; total: number } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  if (index < 1 || index > total) {
    throw new Error(`TEST_SHARD must look like "1/4", got "${value}"`);
  }
  return { index, total };
}
