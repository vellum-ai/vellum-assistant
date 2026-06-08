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
import type { Profile } from "./profile";
import type { EvalProgressReporter } from "./runner/progress";

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

/**
 * Shared input to every benchmark's `run()` method. The CLI builds one
 * of these from its parsed options and hands it to `benchmark.run()` —
 * each benchmark module decides how to translate it into a concrete
 * execution plan (Cartesian profile × test for PI; profile × question
 * with shared trajectory map for V2; …).
 *
 * Benchmark-specific knobs (env vars, dataset roots, tier selection,
 * cache toggles) are read inside each benchmark's `run()` so this
 * shape stays narrow and stable. The one CLI-level knob that flows
 * through is `maxTurns`, because it's literally a `--max-turns` CLI
 * flag and benchmarks that don't honor it just ignore it.
 */
export interface BenchmarkRunInput {
  /** Profiles to evaluate against the benchmark. */
  profiles: Profile[];
  /** Parsed --filter ids; empty when --filter wasn't supplied. */
  filterIds: string[];
  /**
   * Original --filter flag value, kept around so benchmarks can
   * distinguish "operator supplied --filter and got zero matches"
   * from "operator didn't filter and the dataset is empty" — the two
   * cases produce different error messages.
   */
  filterFlag: string | undefined;
  /** Session id stamped onto every (profile, unit) execution. */
  session: string;
  /** Optional human-readable label associated with this session. */
  sessionLabel: string | undefined;
  /**
   * `process.argv` captured at the top of the `evals run` invocation.
   * Forwarded to each benchmark so it can stamp the originating CLI
   * command onto every `RunMetadata` it writes. Undefined when the
   * runner is invoked programmatically (no real CLI argv to record).
   */
  cliArgv: string[] | undefined;
  /** Progress reporter — the same one the CLI built. */
  progress: EvalProgressReporter;
  /**
   * Maximum simulator turns per run. Personal-Intelligence honors
   * this; benchmarks that don't drive a simulator (e.g. V2's
   * ingest→ask flow) ignore it.
   */
  maxTurns: number | undefined;
}

/** Result of a `benchmark.run()` invocation. */
export interface BenchmarkRunResult {
  /** True if any (profile, unit) execution surfaced as failed. */
  anyFailed: boolean;
}

/**
 * Signature each benchmark module's `run()` export must satisfy.
 * Receives the loaded `Benchmark` instance so handlers can read
 * `unitsDir`, `id`, etc., without re-loading the manifest.
 */
export type BenchmarkRunFn = (
  benchmark: Benchmark,
  input: BenchmarkRunInput,
) => Promise<BenchmarkRunResult>;

export interface Benchmark {
  /** Directory name under `benchmarks/`. */
  id: string;
  manifest: BenchmarkManifest;
  /** Absolute path to `benchmarks/<id>/<unitDirName>/`. */
  unitsDir: string;
  /**
   * Execute every (profile × unit) combination for this benchmark.
   * The implementation lives at `benchmarks/<id>/src/run.ts` — that
   * file owns this benchmark's execution shape (Cartesian over
   * `TestDef`s, or over V2's `BenchmarkItem`s with pre-staged
   * trajectory files, or whatever the next benchmark needs).
   */
  run(input: BenchmarkRunInput): Promise<BenchmarkRunResult>;
}

/**
 * Resolve each benchmark's run module by convention:
 * `benchmarks/<id>/src/run.ts` must export a `run` function with the
 * `BenchmarkRunFn` signature. Adding a new benchmark means dropping
 * a `src/run.ts` next to its `manifest.json` — no central registry,
 * no DI wiring (see `software-engineering/dependencies.md`).
 *
 * `id` is validated by `assertSafeId` (called before this function in
 * `loadBenchmark`), so the template literal cannot escape the
 * benchmarks directory at runtime.
 */
async function loadBenchmarkRunFn(id: string): Promise<BenchmarkRunFn> {
  let mod: { run?: unknown };
  try {
    // Dynamic import is the *one* legitimate exception called out in
    // the anti-DI guidance: conditional loading by benchmark id. The
    // path is bounded by `assertSafeId`.
    mod = (await import(`../../benchmarks/${id}/src/run.ts`)) as {
      run?: unknown;
    };
  } catch (err) {
    throw new Error(
      `Benchmark "${id}" is missing a run module at benchmarks/${id}/src/run.ts: ` +
        `${(err as Error).message}`,
    );
  }
  if (typeof mod.run !== "function") {
    throw new Error(
      `Benchmark "${id}"'s run module at benchmarks/${id}/src/run.ts ` +
        `does not export a "run" function.`,
    );
  }
  return mod.run as BenchmarkRunFn;
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

  const runFn = await loadBenchmarkRunFn(id);
  const benchmark: Benchmark = {
    id,
    manifest: result.data,
    unitsDir,
    // Bind `runFn` to *this* benchmark instance so callers can write
    // `await benchmark.run({...})` without having to thread the
    // benchmark back into a free function.
    run: (input) => runFn(benchmark, input),
  };
  return benchmark;
}
