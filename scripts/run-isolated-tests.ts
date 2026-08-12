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
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.TEST_CONCURRENCY ?? "8", 10) || 8,
  );
  const files =
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

  for (let index = 0; index < files.length; index += concurrency) {
    const batch = files.slice(index, index + concurrency);
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
}
