// Bun's coverage reporter only tracks files that are actually loaded during
// test execution. There is no config option to include all source files.
// See: https://github.com/oven-sh/bun/issues/5928
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const EXCLUDE_PATTERNS = [".test.ts", ".d.ts"];
const EXCLUDE_DIRS = [
  // Ink components import yoga-layout whose WASM binary crashes
  // intermittently during headless import (null reference in za()).
  "components/",
];
const EXCLUDE_FILES = [
  // index.ts calls main() at module level, causing side effects on import
  "index.ts",
];

async function importAllModules(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files = [...glob.scanSync(dir)].filter(
    (f) =>
      !EXCLUDE_PATTERNS.some((pattern) => f.endsWith(pattern)) &&
      !EXCLUDE_DIRS.some((dir) => f.startsWith(dir)) &&
      !EXCLUDE_FILES.some((excluded) => f === excluded) &&
      !f.includes("__tests__"),
  );

  await Promise.all(files.map((relPath) => import(resolve(dir, relPath))));

  return files;
}

test("imports all source modules for coverage tracking", async () => {
  /**
   * Ensures all source files are loaded so Bun's coverage reporter
   * includes them in the report, not just files touched by other tests.
   */

  // GIVEN the src directory containing all source modules
  const srcDir = resolve(import.meta.dir, "..");

  // WHEN we dynamically import every source module
  const files = await importAllModules(srcDir);

  // THEN at least one file should have been imported
  expect(files.length).toBeGreaterThan(0);
});
