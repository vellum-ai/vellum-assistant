/**
 * Benchmark — declarative top-level unit of evaluation.
 *
 * Each benchmark lives at `benchmarks/<id>/` with:
 *   - `manifest.json` — display name + the directory + noun describing its units
 *   - `<unitDirName>/` — one subdirectory per individual unit (e.g. `tests/`,
 *     `items/`); the shape of a unit is defined per-benchmark.
 *
 * The benchmark id is the directory name. The manifest does not declare it,
 * matching the `Profile` convention.
 *
 * Personal-Intelligence is our in-house benchmark; LongMemEval-V2 and other
 * public suites live as peers under `benchmarks/`. The harness picks one via
 * `evals run --benchmark <id>`.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { assertSafeId, getBenchmarksDir, resolveUnder } from "./catalog";

/** Same shape as profile/test ids — directory-safe lowercase + hyphens. */
const SAFE_DIR_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Singular noun: lowercase letters/hyphens, no digits, no leading hyphen. */
const SAFE_NOUN = /^[a-z][a-z-]*$/;

export const BenchmarkManifestSchema = z.object({
  /**
   * Human-readable name shown in `evals benchmarks list` and help text.
   * Example: "Personal Intelligence", "LongMemEval v2".
   */
  displayName: z.string().min(1),
  /**
   * Directory under the benchmark root that holds individual units.
   * `personal-intelligence` uses `tests`; `longmemeval-v2` will use `items`.
   * Each benchmark picks the name that matches its vocabulary.
   */
  unitDirName: z.string().regex(SAFE_DIR_NAME),
  /**
   * Singular noun for one unit ("test", "item", "question"). Drives CLI
   * help text and listing-output column labels so each benchmark speaks
   * its own vocabulary.
   */
  unitNoun: z.string().regex(SAFE_NOUN),
});

export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

export interface Benchmark {
  /** Directory name under `benchmarks/`. */
  id: string;
  manifest: BenchmarkManifest;
  /** Absolute path to `benchmarks/<id>/<unitDirName>/`. */
  unitsDir: string;
}

export async function loadBenchmark(id: string): Promise<Benchmark> {
  assertSafeId("benchmark", id);
  const base = getBenchmarksDir();
  const manifestPath = resolveUnder(base, id, "manifest.json");

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Benchmark "${id}" not found — expected ${manifestPath}`);
    }
    throw new Error(
      `Failed to read benchmark "${id}" manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Benchmark "${id}" manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = BenchmarkManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Benchmark "${id}" manifest at ${manifestPath} failed schema validation:\n${issues}`,
    );
  }

  const unitsDir = resolveUnder(base, id, result.data.unitDirName);

  return {
    id,
    manifest: result.data,
    unitsDir,
  };
}
