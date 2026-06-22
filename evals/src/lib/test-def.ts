/**
 * Test definition — directory layout describing what the harness runs.
 *
 * Each test lives at `<unitsDir>/<id>/` with:
 *   - `SPEC.md`  — markdown briefing for the simulator agent.
 *   - `setup.ts` — optional deterministic setup commands.
 *   - `metrics/` — directory of `.ts` files. Each file exports a scorer.
 *
 * The test id is the directory name. The on-disk root is supplied by the
 * caller (typically `loadBenchmark(id).unitsDir`); when omitted it falls
 * back to the personal-intelligence benchmark via `getTestsDir()` so the
 * legacy `evals tests list` surface keeps working.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { assertSafeId, getTestsDir, resolveUnder } from "./catalog";

import type { TestSetupCommand } from "./setup-command";

export interface TestDef {
  /** Directory name under the supplied units root. */
  id: string;
  /** Absolute path to `<unitsDir>/<id>/SPEC.md`. */
  specPath: string;
  /** Absolute path to optional `<unitsDir>/<id>/setup.ts`. */
  setupPath: string;
  /** Deterministic commands run before the simulator starts. */
  setupCommands: TestSetupCommand[];
  /** Absolute path to `<unitsDir>/<id>/metrics/` — may be empty or absent. */
  metricsDir: string;
  /** Absolute paths to each `.ts` file in the metrics directory, sorted. */
  metricPaths: string[];
  /**
   * Lifecycle status declared in SPEC.md YAML frontmatter (e.g.
   * `status: experimental`). Experimental units are excluded from default
   * (unfiltered) benchmark runs until they pass QA; an explicit `--filter`
   * still runs them. Undefined when the SPEC has no frontmatter status.
   */
  status?: string;
}

function parseSpecStatus(spec: string): string | undefined {
  const frontmatter = spec.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;
  const status = frontmatter[1].match(/^status:\s*(\S+)\s*$/m);
  return status?.[1];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function loadSetupCommands(
  setupPath: string,
): Promise<TestSetupCommand[]> {
  if (!(await exists(setupPath))) return [];
  const imported = (await import(setupPath)) as {
    default?: TestSetupCommand[];
  };
  if (!Array.isArray(imported.default)) {
    throw new Error(
      `Test setup at ${setupPath} must export default TestSetupCommand[]`,
    );
  }
  return imported.default;
}

export async function loadTestDef(
  id: string,
  unitsDir: string = getTestsDir(),
): Promise<TestDef> {
  assertSafeId("test", id);
  const specPath = resolveUnder(unitsDir, id, "SPEC.md");
  const setupPath = resolveUnder(unitsDir, id, "setup.ts");
  const metricsDir = resolveUnder(unitsDir, id, "metrics");

  let spec: string;
  try {
    spec = await readFile(specPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Test "${id}" is missing SPEC.md — expected ${specPath}`);
    }
    throw new Error(
      `Failed to read test "${id}" SPEC.md at ${specPath}: ${(err as Error).message}`,
    );
  }

  let metricPaths: string[] = [];
  try {
    const entries = await readdir(metricsDir);
    metricPaths = entries
      .filter((e) => e.endsWith(".ts"))
      .map((e) => resolveUnder(unitsDir, id, "metrics", e))
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
    status: parseSpecStatus(spec),
  };
}
