#!/usr/bin/env bun
/**
 * Test runner with full process isolation for Bun mock.module conflicts.
 *
 * Bun's mock.module is process-global: the last mock.module call for a given
 * specifier wins across ALL test files in the process. Test files that mock a
 * module would otherwise break test files that need the real implementation, so
 * each test file runs in its own Bun process. Files run in parallel (configurable
 * via TEST_WORKERS, default: CPU count).
 *
 * Coverage: set COVERAGE=true to generate per-file lcov reports, merged into
 * coverage/lcov.info at the end.
 *
 * This is a TypeScript port of the former scripts/test.sh; behaviour is intended
 * to match it exactly (file selection, longest-first scheduling, per-file
 * timeout + retry, pass/hung/fail classification, coverage merge).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXCLUDE_EXPERIMENTAL = Bun.env.EXCLUDE_EXPERIMENTAL === "true";
const WORKERS =
  Number.parseInt(Bun.env.TEST_WORKERS ?? "", 10) ||
  navigator.hardwareConcurrency ||
  8;
const COVERAGE = Bun.env.COVERAGE === "true";
// Per-test timeout (seconds). Kills bun processes that pass but don't exit due
// to open handles.
const PER_TEST_TIMEOUT = Number.parseInt(Bun.env.PER_TEST_TIMEOUT ?? "120", 10);
// SIGKILL grace after SIGTERM, mirroring `timeout -k 10`.
const KILL_GRACE_MS = 10_000;
// Longest-first scheduling: a durations file from a previous run sorts slow
// tests to the front, improving parallel utilization.
const TEST_DURATIONS_FILE = Bun.env.TEST_DURATIONS_FILE ?? "";
const TEST_DURATIONS_OUTPUT = Bun.env.TEST_DURATIONS_OUTPUT ?? "";

const EXPERIMENTAL_FILES = new Set([
  "skill-load-tool.test.ts",
  "memory-regressions.experimental.test.ts",
]);

// Tests that exist in the tree but are known-broken when run. Excluded
// unconditionally until triage lands a fix for each. Entries must be
// repo-relative paths (matching by basename would silently exclude every copy
// of ambiguous names like `connect.test.ts` that recur under multiple
// `src/cli/commands/*/__tests__/` directories). To triage: run
// `bun test <path>` and fix until green, then remove it here.
const KNOWN_BROKEN_FILES = new Set<string>([]);

// ---------------------------------------------------------------------------
// Feature-flag registry sync
// ---------------------------------------------------------------------------

// Ensure the bundled feature-flag-registry.json exists before running tests.
// The canonical copy lives at meta/feature-flags/feature-flag-registry.json and
// is synced into assistant/src/ and gateway/src/. CI runs this as a dedicated
// step; locally postinstall handles it — but when node_modules is symlinked
// (e.g. worktrees) postinstall never fires, so the bundled copy can be missing
// and feature-flag-registry-bundled.test.ts fails. Running the sync here is
// idempotent and cheap (two file copies).
function syncFeatureFlagRegistry(): void {
  const syncScript = join(
    "..",
    "meta",
    "feature-flags",
    "sync-bundled-copies.ts",
  );
  if (!existsSync(syncScript)) {
    return;
  }
  Bun.spawnSync(["bun", "run", "meta/feature-flags/sync-bundled-copies.ts"], {
    cwd: join(process.cwd(), ".."),
    stdout: "ignore",
    stderr: "ignore",
  });
}

// ---------------------------------------------------------------------------
// Test-file collection
// ---------------------------------------------------------------------------

function collectTestFiles(): string[] {
  const glob = new Bun.Glob("src/**/*.test.ts");
  const files: string[] = [];
  for (const file of glob.scanSync(".")) {
    const base = basename(file);
    if (EXCLUDE_EXPERIMENTAL && EXPERIMENTAL_FILES.has(base)) {
      continue;
    }
    // Always exclude benchmark files — run them with `bun run test:bench`.
    if (base.endsWith(".benchmark.test.ts")) {
      continue;
    }
    // Compare against the full repo-relative path — matching by basename would
    // silently drop every copy of ambiguous filenames.
    if (KNOWN_BROKEN_FILES.has(file)) {
      continue;
    }
    files.push(file);
  }
  return files.sort();
}

// Sort tests longest-first using durations from a previous run, so slow tests
// start immediately across all workers instead of piling up at the end and
// becoming long poles.
function sortLongestFirst(files: string[]): string[] {
  if (!TEST_DURATIONS_FILE || !existsSync(TEST_DURATIONS_FILE)) {
    return files;
  }
  const durMap = new Map<string, number>();
  for (const line of readFileSync(TEST_DURATIONS_FILE, "utf-8").split("\n")) {
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const ms = Number.parseInt(line.slice(0, tab), 10);
    const path = line.slice(tab + 1);
    if (path) {
      durMap.set(path, ms);
    }
  }
  const known: string[] = [];
  const unknown: string[] = [];
  for (const f of files) {
    (durMap.has(f) ? known : unknown).push(f);
  }
  known.sort((a, b) => (durMap.get(b) ?? 0) - (durMap.get(a) ?? 0));
  console.log(
    `Sorted tests longest-first using ${TEST_DURATIONS_FILE} (${known.length} known, ${unknown.length} new)`,
  );
  return [...known, ...unknown];
}

// ---------------------------------------------------------------------------
// Running a single test file
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

const hasFailedAssertion = (out: string): boolean => /^\(fail\)/m.test(out);
const reachedEndOfRun = (out: string): boolean =>
  /^Ran \d+ tests? across/m.test(out);

async function runBunTest(
  file: string,
  coverageArgs: string[],
): Promise<RunResult> {
  const args = ["test", ...coverageArgs];
  if (EXCLUDE_EXPERIMENTAL) {
    args.push("--test-name-pattern", "^(?!.*\\[experimental\\])");
  }
  args.push(file);

  const proc = Bun.spawn(["bun", ...args], { stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    graceTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, KILL_GRACE_MS);
  }, PER_TEST_TIMEOUT * 1000);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (killTimer) {
    clearTimeout(killTimer);
  }
  if (graceTimer) {
    clearTimeout(graceTimer);
  }

  return { exitCode, output: stdout + stderr, timedOut };
}

type Outcome = "pass" | "fail" | "hung-pass";

interface FileResult {
  file: string;
  outcome: Outcome;
  elapsedMs: number;
  output: string;
}

async function runOneFile(
  file: string,
  resultsDir: string,
): Promise<FileResult> {
  const base = basename(file);
  const coverageArgs: string[] = [];
  if (COVERAGE) {
    const safe = file.replace(/\//g, "_");
    const covDir = join(resultsDir, `cov_${safe}`);
    mkdirSync(covDir, { recursive: true });
    coverageArgs.push(
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${covDir}`,
    );
  }

  const start = performance.now();
  let { exitCode, output, timedOut } = await runBunTest(file, coverageArgs);

  // Retry once when a failing run produced no conclusive test evidence:
  //   - transient loader/runtime crash (non-zero, non-timeout exit)
  //   - transient hang (timeout kill before the end-of-run summary)
  // Neither leaves a "(fail)" line; genuine assertion failures print one and
  // are reported immediately (fast feedback, no masking of intermittent
  // failures). A timed-out run that reached the end-of-run summary is the
  // passed-but-hung-at-exit case — no retry needed.
  let retryReason = "";
  if (exitCode !== 0 && !hasFailedAssertion(output)) {
    if (timedOut) {
      if (!reachedEndOfRun(output)) {
        retryReason = `hung after ${PER_TEST_TIMEOUT}s without completing`;
      }
    } else {
      retryReason = `transient crash, exit ${exitCode}`;
    }
  }
  if (retryReason) {
    console.log(`  ↻ ${base} (${retryReason} — retrying once)`);
    ({ exitCode, output, timedOut } = await runBunTest(file, coverageArgs));
  }

  const elapsedMs = Math.round(performance.now() - start);

  let outcome: Outcome;
  let line: string;
  if (timedOut) {
    // The process was killed by the timeout. It passed only if there were no
    // failures AND the end-of-run summary is present; without the summary it
    // was killed mid-run.
    if (hasFailedAssertion(output)) {
      outcome = "fail";
      line = `  ✗ ${base} (killed after ${PER_TEST_TIMEOUT}s — tests failed and process hung)`;
    } else if (reachedEndOfRun(output)) {
      outcome = "hung-pass";
      line = `  ⚠ ${base} (tests passed but process hung after ${PER_TEST_TIMEOUT}s — likely open handles)`;
    } else {
      outcome = "fail";
      line = `  ✗ ${base} (killed after ${PER_TEST_TIMEOUT}s — test run did not complete)`;
    }
  } else if (exitCode !== 0) {
    outcome = "fail";
    line = `  ✗ ${base} (${elapsedMs}ms)`;
  } else {
    outcome = "pass";
    line = `  ✓ ${base} (${elapsedMs}ms)`;
  }
  console.log(line);

  return { file, outcome, elapsedMs, output };
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) {
        return;
      }
      results[idx] = await worker(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Coverage merge (port of the former awk merge)
//
// Merges per-shard lcov reports, deduplicating source files that appear in
// multiple shards — raw concatenation would count shared files multiple times.
// DA/FNDA/BRDA execution counts are summed; FN/DA/BRDA identities keep their
// first-seen order.
// ---------------------------------------------------------------------------

function mergeLcov(rawLcovDir: string, mergedPath: string): boolean {
  interface FileCov {
    daOrder: string[]; // line numbers in first-seen order
    da: Map<string, number>; // line -> summed count
    fnOrder: string[]; // "line,name" in first-seen order
    fnSeen: Set<string>;
    fndaOrder: string[]; // "line,name" in first-seen order
    fnda: Map<string, number>; // "line,name" -> summed count
    brdaOrder: string[]; // "line,block,branch" in first-seen order
    brda: Map<string, number>; // key -> summed taken
    brdaNumeric: Set<string>; // keys that had a numeric taken
  }
  const filesMap = new Map<string, FileCov>();
  const fileOrder: string[] = [];

  const emptyCov = (): FileCov => ({
    daOrder: [],
    da: new Map(),
    fnOrder: [],
    fnSeen: new Set(),
    fndaOrder: [],
    fnda: new Map(),
    brdaOrder: [],
    brda: new Map(),
    brdaNumeric: new Set(),
  });

  // Concatenate all shard lcov files, then walk line by line.
  const shardDirs = readdirSync(rawLcovDir).filter((d) => d.startsWith("cov_"));
  let sawAny = false;
  for (const dir of shardDirs) {
    const lcovFile = join(rawLcovDir, dir, "lcov.info");
    if (!existsSync(lcovFile)) {
      continue;
    }
    sawAny = true;
    let cur: FileCov | null = null;
    // FN/FNDA are paired by position WITHIN a shard's SF block.
    let blkFnAt: string[] = [];
    let blkFndaIdx = 0;
    for (const raw of readFileSync(lcovFile, "utf-8").split("\n")) {
      if (raw.startsWith("SF:")) {
        const sf = raw.slice(3);
        if (!filesMap.has(sf)) {
          filesMap.set(sf, emptyCov());
          fileOrder.push(sf);
        }
        cur = filesMap.get(sf)!;
        blkFnAt = [];
        blkFndaIdx = 0;
      } else if (raw.startsWith("DA:") && cur) {
        const [line, countStr] = raw.slice(3).split(",");
        const count = Number.parseInt(countStr, 10) || 0;
        if (cur.da.has(line)) {
          cur.da.set(line, cur.da.get(line)! + count);
        } else {
          cur.da.set(line, count);
          cur.daOrder.push(line);
        }
      } else if (raw.startsWith("FN:") && cur) {
        const entry = raw.slice(3); // "line,name"
        if (!cur.fnSeen.has(entry)) {
          cur.fnSeen.add(entry);
          cur.fnOrder.push(entry);
        }
        blkFnAt.push(entry);
      } else if (raw.startsWith("FNDA:") && cur) {
        const rest = raw.slice(5); // "count,name"
        const count = Number.parseInt(rest.split(",")[0], 10) || 0;
        // Pair with the FN at the same position within this shard's block.
        const fnFull = blkFnAt[blkFndaIdx] ?? rest.slice(rest.indexOf(",") + 1);
        blkFndaIdx++;
        if (cur.fnda.has(fnFull)) {
          cur.fnda.set(fnFull, cur.fnda.get(fnFull)! + count);
        } else {
          cur.fnda.set(fnFull, count);
          cur.fndaOrder.push(fnFull);
        }
      } else if (raw.startsWith("BRDA:") && cur) {
        const parts = raw.slice(5).split(",");
        const key = `${parts[0]},${parts[1]},${parts[2]}`;
        const taken = parts[3];
        if (taken === "-") {
          if (!cur.brdaNumeric.has(key) && !cur.brda.has(key)) {
            cur.brda.set(key, 0);
          }
        } else {
          const t = Number.parseInt(taken, 10) || 0;
          if (cur.brdaNumeric.has(key)) {
            cur.brda.set(key, (cur.brda.get(key) ?? 0) + t);
          } else {
            cur.brda.set(key, t);
          }
          cur.brdaNumeric.add(key);
        }
        if (!cur.brdaOrder.includes(key)) {
          cur.brdaOrder.push(key);
        }
      }
    }
  }

  if (!sawAny) {
    return false;
  }

  const out: string[] = [];
  for (const sf of fileOrder) {
    const cov = filesMap.get(sf)!;
    out.push(`SF:${sf}`);
    for (const fn of cov.fnOrder) {
      out.push(`FN:${fn}`);
    }
    let fnf = 0;
    let fnh = 0;
    for (const entry of cov.fndaOrder) {
      const count = cov.fnda.get(entry)!;
      // entry is "line,name" — strip leading "line," to get the name.
      const comma = entry.indexOf(",");
      const name = comma === -1 ? entry : entry.slice(comma + 1);
      out.push(`FNDA:${count},${name}`);
      fnf++;
      if (count > 0) {
        fnh++;
      }
    }
    out.push(`FNF:${fnf}`);
    out.push(`FNH:${fnh}`);
    let brf = 0;
    let brh = 0;
    const brLines: string[] = [];
    for (const key of cov.brdaOrder) {
      if (cov.brdaNumeric.has(key)) {
        const taken = cov.brda.get(key)!;
        brLines.push(`BRDA:${key},${taken}`);
        brf++;
        if (taken > 0) {
          brh++;
        }
      } else {
        brLines.push(`BRDA:${key},-`);
        brf++;
      }
    }
    out.push(...brLines);
    if (brf > 0) {
      out.push(`BRF:${brf}`);
      out.push(`BRH:${brh}`);
    }
    let lf = 0;
    let lh = 0;
    for (const line of cov.daOrder) {
      const count = cov.da.get(line)!;
      out.push(`DA:${line},${count}`);
      lf++;
      if (count > 0) {
        lh++;
      }
    }
    out.push(`LF:${lf}`);
    out.push(`LH:${lh}`);
    out.push("end_of_record");
  }
  writeFileSync(mergedPath, out.join("\n") + "\n");
  return true;
}

// ---------------------------------------------------------------------------
// Migrated-workspace fixture
// ---------------------------------------------------------------------------

// Build the migrated-DB fixture once, up front, in a dedicated subprocess. Each
// test process's preload copies it into that process's tmp workspace, so a test
// that calls initializeDb() opens an already-migrated DB and the migration
// runner no-ops via its checkpoint ledger instead of re-running the whole chain
// ~1800 times. The subprocess (rather than an in-process import) keeps the
// persistence graph out of this orchestrator and mirrors a real from-scratch
// migration. Workers are handed the fixtures root via VELLUM_TEST_FIXTURES_DIR
// (inherited through Bun.spawn's default env inheritance); "migrated" is one
// named fixture under it, leaving room for more.
async function buildMigratedFixture(outWorkspaceDir: string): Promise<void> {
  const script = join(import.meta.dir, "build-test-fixtures.ts");
  const proc = Bun.spawn(["bun", "run", script, outWorkspaceDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`Failed to build migrated test fixture (exit ${code})`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  syncFeatureFlagRegistry();

  let testFiles = collectTestFiles();
  if (testFiles.length === 0) {
    console.log("No test files found under src");
    process.exit(1);
  }
  testFiles = sortLongestFirst(testFiles);

  const fixturesRoot = mkdtempSync(join(tmpdir(), "vellum-test-fixtures-"));
  await buildMigratedFixture(join(fixturesRoot, "migrated"));
  process.env.VELLUM_TEST_FIXTURES_DIR = fixturesRoot;

  console.log(`Running ${testFiles.length} test files (${WORKERS} workers)`);

  const resultsDir = mkdtempSync(join(tmpdir(), "vellum-test-run-"));
  let coverageBase = "";
  if (COVERAGE) {
    coverageBase = join(process.cwd(), "coverage");
    rmSync(coverageBase, { recursive: true, force: true });
    mkdirSync(coverageBase, { recursive: true });
  }

  try {
    const results = await runPool(testFiles, WORKERS, (f) =>
      runOneFile(f, resultsDir),
    );

    // Record durations for longest-first scheduling in future runs. Written
    // before the failure exit so durations persist even when tests fail.
    if (TEST_DURATIONS_OUTPUT) {
      const sorted = [...results].sort((a, b) => b.elapsedMs - a.elapsedMs);
      writeFileSync(
        TEST_DURATIONS_OUTPUT,
        sorted.map((r) => `${r.elapsedMs}\t${r.file}`).join("\n") + "\n",
      );
      console.log(`Wrote test durations to ${TEST_DURATIONS_OUTPUT}`);
    }

    const failures = results.filter((r) => r.outcome === "fail");
    if (failures.length > 0) {
      console.log("");
      for (const r of failures) {
        console.log("──────────────────────────────────────────");
        console.log(`FAIL: ${r.file}`);
        console.log("──────────────────────────────────────────");
        process.stdout.write(r.output);
        console.log("");
      }
      console.log("========================================");
      console.log(`  FAILED TEST FILES (${failures.length}):`);
      console.log("========================================");
      for (const r of failures) {
        console.log(`  ✗ ${r.file}`);
      }
      console.log("========================================");
      process.exit(1);
    }

    if (COVERAGE) {
      const mergedPath = join(coverageBase, "lcov.info");
      if (mergeLcov(resultsDir, mergedPath)) {
        console.log("Coverage report written to coverage/lcov.info");
      } else {
        console.log("Warning: no coverage data was generated");
      }
    }

    console.log(`All ${testFiles.length} test files passed`);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(fixturesRoot, { recursive: true, force: true });
  }
}

await main();
