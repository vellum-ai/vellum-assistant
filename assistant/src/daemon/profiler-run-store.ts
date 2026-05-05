/**
 * Profiler run store — manages profiler run directories, manifest state,
 * and retention budget enforcement.
 *
 * Each profiler run lives in its own sub-directory under the profiler runs
 * directory (<workspace>/data/profiler/runs/<runId>/). A small manifest.json
 * in each run directory records metadata (status, timestamps, byte count).
 *
 * The startup sweep enumerates all run directories, recomputes sizes,
 * updates manifests, and prunes completed runs oldest-first until the
 * configured byte-count, run-count, and free-space budgets are satisfied.
 * The active run (identified by VELLUM_PROFILER_RUN_ID) is never deleted.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  getProfilerMaxBytes,
  getProfilerMaxRuns,
  getProfilerMinFreeMb,
  getProfilerMode,
  getProfilerRunId,
} from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import {
  getProfilerRootDir,
  getProfilerRunDir,
  getProfilerRunsDir,
} from "../util/platform.js";

const log = getLogger("profiler-run-store");

// ── Manifest schema ─────────────────────────────────────────────────────

export interface ProfilerRunManifest {
  /** Unique run identifier (matches the directory name). */
  runId: string;
  /** "active" while profiling is in progress; "completed" once finished. */
  status: "active" | "completed";
  /** ISO-8601 timestamp when the run was first observed. */
  createdAt: string;
  /** ISO-8601 timestamp of the last manifest update. */
  updatedAt: string;
  /** Total bytes consumed by all files in the run directory. */
  totalBytes: number;
  /** ISO-8601 timestamp when the run transitioned to "completed". */
  completedAt?: string;
}

const MANIFEST_FILENAME = "manifest.json";

// ── Default budgets ─────────────────────────────────────────────────────

/** Default max total bytes across all runs (including active): 500 MB */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/** Default max number of completed runs retained: 10 */
const DEFAULT_MAX_RUNS = 10;

/** Default minimum free disk space: 200 MB */
const DEFAULT_MIN_FREE_MB = 200;

// ── Result type ─────────────────────────────────────────────────────────

interface ProfilerSweepResult {
  /** Number of completed runs pruned during this sweep. */
  prunedCount: number;
  /** Total bytes freed by pruning. */
  freedBytes: number;
  /** When true, the active run alone exceeds the byte budget. */
  activeRunOverBudget: boolean;
  /** Number of runs remaining after the sweep (including active). */
  remainingRuns: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Recursively compute the total byte size of all files in a directory.
 * Uses lstatSync to avoid following symlinks (prevents infinite loops
 * from symlink cycles and avoids counting out-of-tree data).
 */
function computeDirBytes(dirPath: string): number {
  let total = 0;
  if (!existsSync(dirPath)) return 0;

  const names = readdirSync(dirPath);
  for (const name of names) {
    const entryPath = join(dirPath, name);
    try {
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        total += computeDirBytes(entryPath);
      } else if (stat.isFile()) {
        total += stat.size;
      }
    } catch {
      // Entry may have been removed between readdir and stat
    }
  }
  return total;
}

/**
 * Read a manifest.json from a run directory, returning null if missing or
 * unparseable.
 */
function readManifest(runDir: string): ProfilerRunManifest | null {
  const manifestPath = join(runDir, MANIFEST_FILENAME);
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as ProfilerRunManifest;
  } catch {
    return null;
  }
}

/**
 * Write a manifest.json into a run directory, creating the directory if
 * needed.
 */
function writeManifest(runDir: string, manifest: ProfilerRunManifest): void {
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  writeFileSync(
    join(runDir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Get the available free bytes on the filesystem containing the given path.
 */
function getFreeDiskBytes(path: string): number {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    // If statfs fails (e.g. unsupported FS), return a large value so the
    // free-space budget doesn't spuriously trigger pruning.
    return Number.MAX_SAFE_INTEGER;
  }
}

// ── Core operations ─────────────────────────────────────────────────────

/** Options for {@link rescanRuns}. */
interface RescanRunsOptions {
  /**
   * When true, skip all `writeManifest()` calls — just read existing
   * manifests and recompute sizes without mutating the filesystem.
   * Used by health endpoints to avoid write side-effects on every poll.
   */
  readOnly?: boolean;
}

/**
 * Enumerate all profiler run directories, recompute sizes, and return
 * up-to-date manifests. By default also writes updated manifests back
 * to disk; pass `{ readOnly: true }` to suppress writes (e.g. from
 * health-check callers).
 */
export function rescanRuns(options?: RescanRunsOptions): ProfilerRunManifest[] {
  const readOnly = options?.readOnly ?? false;
  const runsDir = getProfilerRunsDir();
  if (!existsSync(runsDir)) return [];

  const activeRunId = getProfilerRunId();
  const manifests: ProfilerRunManifest[] = [];
  const now = new Date().toISOString();

  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }

  for (const runId of names) {
    const runDir = getProfilerRunDir(runId);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const totalBytes = computeDirBytes(runDir);

    const existing = readManifest(runDir);
    const isActive = runId === activeRunId;

    // For first-time manifests (no existing manifest.json), seed createdAt
    // from the directory's mtime so legacy runs preserve their actual age
    // for oldest-first pruning order.
    let createdAt = existing?.createdAt ?? now;
    if (!existing) {
      try {
        createdAt = statSync(runDir).mtime.toISOString();
      } catch {
        // Fall back to current time if stat fails
      }
    }

    const newStatus: "active" | "completed" = isActive ? "active" : "completed";

    // Determine completedAt: set it when a run transitions to completed
    // for the first time, otherwise preserve the existing value.
    let completedAt = existing?.completedAt;
    if (
      newStatus === "completed" &&
      !completedAt &&
      (existing?.status === "active" || !existing)
    ) {
      completedAt = now;
    }

    // Only bump updatedAt when something meaningful changed compared to
    // the on-disk manifest (status, totalBytes, or first creation).
    const somethingChanged =
      !existing ||
      existing.status !== newStatus ||
      existing.totalBytes !== totalBytes;
    const updatedAt = somethingChanged ? now : existing.updatedAt;

    const manifest: ProfilerRunManifest = {
      runId,
      status: newStatus,
      createdAt,
      updatedAt,
      totalBytes,
      ...(completedAt ? { completedAt } : {}),
    };

    if (!readOnly) {
      writeManifest(runDir, manifest);
    }
    manifests.push(manifest);
  }

  return manifests;
}

/**
 * Run the profiler retention sweep. This is the primary entry point,
 * called on daemon startup and after explicit cleanup operations.
 *
 * The sweep:
 * 1. Rescans all run directories and updates manifests.
 * 2. Separates completed runs from the active run.
 * 3. Sorts completed runs oldest-first by createdAt.
 * 4. Prunes completed runs until all budgets are satisfied:
 *    - Total bytes across all runs <= maxBytes
 *    - Total completed run count <= maxRuns
 *    - Free disk space >= minFreeMb
 *
 * If the active run alone exceeds the byte budget, no runs are pruned
 * (you can't prune the active run), and the over-budget condition is
 * reported.
 */
export function runProfilerSweep(): ProfilerSweepResult {
  const runsDir = getProfilerRunsDir();

  // Ensure the runs directory exists for clean first-boot
  if (!existsSync(runsDir)) {
    const rootDir = getProfilerRootDir();
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
  }

  const manifests = rescanRuns();
  const activeRunId = getProfilerRunId();

  // Budget configuration
  const maxBytes = getProfilerMaxBytes() ?? DEFAULT_MAX_BYTES;
  const maxRuns = getProfilerMaxRuns() ?? DEFAULT_MAX_RUNS;
  const minFreeMb = getProfilerMinFreeMb() ?? DEFAULT_MIN_FREE_MB;
  const minFreeBytes = minFreeMb * 1024 * 1024;

  // Separate active vs completed
  const activeManifest = manifests.find(
    (m) => m.runId === activeRunId && m.status === "active",
  );
  const completedRuns = manifests
    .filter((m) => m.status === "completed")
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

  let totalBytes = manifests.reduce((sum, m) => sum + m.totalBytes, 0);
  let prunedCount = 0;
  let freedBytes = 0;

  // Prune completed runs oldest-first until all budgets are met
  while (completedRuns.length > 0) {
    const overBytesBudget = totalBytes > maxBytes;
    const overRunCount = completedRuns.length > maxRuns;
    const overFreeSpace = getFreeDiskBytes(runsDir) < minFreeBytes;

    if (!overBytesBudget && !overRunCount && !overFreeSpace) break;

    const oldest = completedRuns[0]!;
    const runDir = getProfilerRunDir(oldest.runId);

    log.info(
      {
        runId: oldest.runId,
        bytes: oldest.totalBytes,
        reason: overBytesBudget
          ? "byte_budget"
          : overRunCount
            ? "run_count"
            : "free_space",
      },
      `Pruning completed profiler run`,
    );

    try {
      rmSync(runDir, { recursive: true, force: true });
      completedRuns.shift();
      totalBytes -= oldest.totalBytes;
      freedBytes += oldest.totalBytes;
      prunedCount++;
    } catch (err) {
      log.warn(
        { runId: oldest.runId, err },
        "Failed to remove profiler run directory",
      );
      // The run still exists on disk — leave it in completedRuns so
      // remainingRuns stays accurate. Break to avoid an infinite retry
      // loop on the same un-deletable run.
      break;
    }
  }

  // Check if the active run alone exceeds the byte budget
  const activeRunOverBudget =
    activeManifest !== undefined && activeManifest.totalBytes > maxBytes;

  if (activeRunOverBudget) {
    log.warn(
      {
        runId: activeManifest.runId,
        activeBytes: activeManifest.totalBytes,
        maxBytes,
      },
      "Active profiler run exceeds byte budget — cannot prune live artifacts",
    );
  }

  const remainingRuns =
    completedRuns.length + (activeManifest !== undefined ? 1 : 0);

  if (prunedCount > 0) {
    log.info(
      { prunedCount, freedBytes, remainingRuns },
      "Profiler retention sweep complete",
    );
  }

  return {
    prunedCount,
    freedBytes,
    activeRunOverBudget,
    remainingRuns,
  };
}

// ── Runtime status helpers ──────────────────────────────────────────────
// These derive the current profiler state from env vars + filesystem for
// health-endpoint reporting and control-plane polling.

/** Budget state for the active profiler run. */
interface ProfilerBudgetStatus {
  /** Configured maximum bytes across all runs. */
  maxBytes: number;
  /** Bytes remaining before the byte-count budget is exceeded. */
  remainingBytes: number;
  /** Configured minimum free disk space in MB. */
  minFreeMb: number;
  /** Current free disk space in MB. */
  freeMb: number;
  /** True when any budget constraint is currently violated. */
  overBudget: boolean;
}

/** Summary of the most recently completed profiler run. */
interface ProfilerLastCompletedRun {
  runId: string;
  totalBytes: number;
  artifactCount: number;
  hasSummaries: boolean;
  completedAt: string;
}

/** Full runtime status snapshot for health-endpoint embedding. */
interface ProfilerRuntimeStatus {
  /** Whether profiling is enabled (env vars present). */
  enabled: boolean;
  /** The profiling mode ("cpu", "heap", "cpu+heap"), or null when disabled. */
  mode: string | null;
  /** The active run ID, or null when disabled. */
  runId: string | null;
  /** Path to the active run directory, or null when disabled. */
  runDir: string | null;
  /** Total bytes consumed by the active run, or 0 when no active run. */
  totalBytes: number;
  /** Number of profiler artifact files in the active run directory. */
  artifactCount: number;
  /** Budget headroom for the active run. Null when profiling is disabled. */
  budget: ProfilerBudgetStatus | null;
  /** Summary of the most recently completed run, or null when none exist. */
  lastCompletedRun: ProfilerLastCompletedRun | null;
}

/** File extensions that Bun profiler writes as raw artifacts. */
const PROFILER_ARTIFACT_EXTENSIONS = [".cpuprofile", ".heapsnapshot"];

/** File extensions for Bun-generated markdown summaries. */
const PROFILER_SUMMARY_EXTENSIONS = [".md"];

/**
 * Count profiler artifact files (raw profiles) in a run directory.
 */
function countArtifacts(runDir: string): number {
  if (!existsSync(runDir)) return 0;
  try {
    return readdirSync(runDir).filter((name) =>
      PROFILER_ARTIFACT_EXTENSIONS.some((ext) => name.endsWith(ext)),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Check whether any Bun-generated markdown summary files exist in a run
 * directory.
 */
function hasSummaryFiles(runDir: string): boolean {
  if (!existsSync(runDir)) return false;
  try {
    return readdirSync(runDir).some((name) =>
      PROFILER_SUMMARY_EXTENSIONS.some((ext) => name.endsWith(ext)),
    );
  } catch {
    return false;
  }
}

/**
 * Derive the full profiler runtime status from environment variables and
 * the filesystem. This is the main entry point for health-endpoint
 * integration — it never throws.
 */
export function getProfilerRuntimeStatus(): ProfilerRuntimeStatus {
  const runId = getProfilerRunId() ?? null;
  const mode = getProfilerMode() ?? null;
  const enabled = runId !== null && mode !== null;

  if (!enabled) {
    return {
      enabled: false,
      mode: null,
      runId: null,
      runDir: null,
      totalBytes: 0,
      artifactCount: 0,
      budget: null,
      lastCompletedRun: null,
    };
  }

  const runDir = getProfilerRunDir(runId!);
  const runsDir = getProfilerRunsDir();

  // Rescan to get up-to-date manifests — read-only so health checks
  // don't write to disk on every poll.
  let manifests: ProfilerRunManifest[];
  try {
    manifests = rescanRuns({ readOnly: true });
  } catch {
    manifests = [];
  }

  const activeManifest = manifests.find(
    (m) => m.runId === runId && m.status === "active",
  );
  const totalBytes = activeManifest?.totalBytes ?? 0;
  const artifactCount = countArtifacts(runDir);

  // Compute budget state
  const maxBytes = getProfilerMaxBytes() ?? DEFAULT_MAX_BYTES;
  const minFreeMb = getProfilerMinFreeMb() ?? DEFAULT_MIN_FREE_MB;
  const allRunBytes = manifests.reduce((sum, m) => sum + m.totalBytes, 0);
  const remainingBytes = Math.max(0, maxBytes - allRunBytes);
  const freeDiskBytes = getFreeDiskBytes(
    existsSync(runsDir) ? runsDir : runDir,
  );
  const freeMb = Math.round((freeDiskBytes / (1024 * 1024)) * 100) / 100;
  const overBudget =
    allRunBytes > maxBytes || freeDiskBytes < minFreeMb * 1024 * 1024;

  const budget: ProfilerBudgetStatus = {
    maxBytes,
    remainingBytes,
    minFreeMb,
    freeMb,
    overBudget,
  };

  // Find most recent completed run for lastCompletedRun summary
  const completedRuns = manifests
    .filter((m) => m.status === "completed")
    .sort(
      (a, b) =>
        new Date(b.completedAt ?? b.createdAt).getTime() -
        new Date(a.completedAt ?? a.createdAt).getTime(),
    );

  let lastCompletedRun: ProfilerLastCompletedRun | null = null;
  if (completedRuns.length > 0) {
    const latest = completedRuns[0]!;
    const latestDir = getProfilerRunDir(latest.runId);
    lastCompletedRun = {
      runId: latest.runId,
      totalBytes: latest.totalBytes,
      artifactCount: countArtifacts(latestDir),
      hasSummaries: hasSummaryFiles(latestDir),
      completedAt: latest.completedAt ?? latest.updatedAt,
    };
  }

  return {
    enabled,
    mode,
    runId,
    runDir,
    totalBytes,
    artifactCount,
    budget,
    lastCompletedRun,
  };
}
