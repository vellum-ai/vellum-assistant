/** Catalog discovery helpers for profile, benchmark, and benchmark-unit ids. */
import { readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_DIR = join(HERE, "..", "..", "profiles");
const DEFAULT_BENCHMARKS_DIR = join(HERE, "..", "..", "benchmarks");

/**
 * Benchmark id used when callers don't specify one. Points at the in-house
 * Personal-Intelligence benchmark; the legacy `--tests` flag and bare
 * `evals tests list` invocation both resolve through this default.
 */
export const DEFAULT_BENCHMARK_ID = "personal-intelligence";

const DEFAULT_TESTS_DIR = join(
  DEFAULT_BENCHMARKS_DIR,
  DEFAULT_BENCHMARK_ID,
  "tests",
);

export function getProfilesDir(): string {
  return process.env.EVALS_PROFILES_DIR ?? DEFAULT_PROFILES_DIR;
}

export function getBenchmarksDir(): string {
  return process.env.EVALS_BENCHMARKS_DIR ?? DEFAULT_BENCHMARKS_DIR;
}

/**
 * Back-compat shortcut to the personal-intelligence benchmark's units dir.
 *
 * New code should prefer `loadBenchmark(id).unitsDir`. This helper exists for
 * the legacy `evals tests list` surface and tests that pre-date the
 * `--benchmark` flag.
 */
export function getTestsDir(): string {
  return process.env.EVALS_TESTS_DIR ?? DEFAULT_TESTS_DIR;
}

export function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid ${kind} id "${id}" — must match ${SAFE_ID.source}`,
    );
  }
}

export function resolveUnder(baseDir: string, ...segments: string[]): string {
  const base = resolve(baseDir);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to resolve path outside of ${base}: ${target}`);
  }
  return target;
}

async function listDirectoryIds(rootDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new Error(
      `Failed to read eval catalog directory at ${rootDir}: ${(err as Error).message}`,
    );
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export async function listProfileIds(): Promise<string[]> {
  const ids = await listDirectoryIds(getProfilesDir());
  ids.forEach((id) => assertSafeId("profile", id));
  return ids;
}

export async function listBenchmarkIds(): Promise<string[]> {
  const ids = await listDirectoryIds(getBenchmarksDir());
  ids.forEach((id) => assertSafeId("benchmark", id));
  return ids;
}

/**
 * List unit ids inside an already-resolved benchmark units directory.
 *
 * Callers should resolve the directory via `loadBenchmark(id).unitsDir`
 * rather than hand-constructing the path.
 */
export async function listBenchmarkUnitIds(
  unitsDir: string,
): Promise<string[]> {
  const ids = await listDirectoryIds(unitsDir);
  ids.forEach((id) => assertSafeId("unit", id));
  return ids;
}

/**
 * Back-compat alias for `listBenchmarkUnitIds(getTestsDir())`. Used by
 * `evals tests list` and legacy callers that pre-date the `--benchmark`
 * flag. New code should call `listBenchmarkUnitIds` against an explicit
 * benchmark's `unitsDir`.
 */
export async function listTestIds(): Promise<string[]> {
  return listBenchmarkUnitIds(getTestsDir());
}
