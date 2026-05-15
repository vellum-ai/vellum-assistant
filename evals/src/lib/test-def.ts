/**
 * Test definition — directory layout describing what the harness runs.
 *
 * Each test lives at `tests/<id>/` with:
 *   - `SPEC.md`    — markdown briefing for the simulator agent.
 *   - `setup.json` — optional deterministic setup commands.
 *   - `metrics/`   — directory of `.ts` files. Each file exports a scorer.
 *
 * The test id is the directory name.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { TestSetupCommand } from "./setup-command";

export interface TestDef {
  /** Directory name under `tests/`. */
  id: string;
  /** Absolute path to `tests/<id>/SPEC.md`. */
  specPath: string;
  /** Absolute path to optional `tests/<id>/setup.json`. */
  setupPath: string;
  /** Deterministic commands run before the simulator starts. */
  setupCommands: TestSetupCommand[];
  /** Absolute path to `tests/<id>/metrics/` — may be empty or absent. */
  metricsDir: string;
  /** Absolute paths to each `.ts` file in the metrics directory, sorted. */
  metricPaths: string[];
}

const SetupCommandSchema = z.object({
  type: z.literal("user-message"),
  content: z.string().min(1),
});
const SetupSchema = z.array(SetupCommandSchema);

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TESTS_DIR = join(HERE, "..", "..", "tests");

function testsDir(): string {
  return process.env.EVALS_TESTS_DIR ?? DEFAULT_TESTS_DIR;
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid ${kind} id "${id}" — must match ${SAFE_ID.source}`,
    );
  }
}

function resolveUnder(baseDir: string, ...segments: string[]): string {
  const base = resolve(baseDir);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to resolve path outside of ${base}: ${target}`);
  }
  return target;
}

async function loadSetupCommands(
  setupPath: string,
): Promise<TestSetupCommand[]> {
  let raw: string;
  try {
    raw = await readFile(setupPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Test setup at ${setupPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = SetupSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Test setup at ${setupPath} failed schema validation:\n${issues}`,
    );
  }
  return result.data;
}

export async function loadTestDef(id: string): Promise<TestDef> {
  assertSafeId("test", id);
  const base = testsDir();
  const specPath = resolveUnder(base, id, "SPEC.md");
  const setupPath = resolveUnder(base, id, "setup.json");
  const metricsDir = resolveUnder(base, id, "metrics");

  try {
    await stat(specPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Test "${id}" is missing SPEC.md — expected ${specPath}`);
    }
    throw new Error(
      `Failed to stat test "${id}" SPEC.md at ${specPath}: ${(err as Error).message}`,
    );
  }

  let metricPaths: string[] = [];
  try {
    const entries = await readdir(metricsDir);
    metricPaths = entries
      .filter((e) => e.endsWith(".ts"))
      .map((e) => resolveUnder(base, id, "metrics", e))
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  return {
    id,
    specPath,
    setupPath,
    setupCommands: await loadSetupCommands(setupPath),
    metricsDir,
    metricPaths,
  };
}
