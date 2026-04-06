/**
 * Tests for the profiler run store: manifest management, retention sweep,
 * active-run protection, oldest-first pruning, max-run-count pruning,
 * active-run-over-budget signaling, and idempotent rescans.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProfilerRunManifest } from "../daemon/profiler-run-store.js";
import { rescanRuns, runProfilerSweep } from "../daemon/profiler-run-store.js";

// ── Test scaffolding ────────────────────────────────────────────────────

let testDir: string;
let runsDir: string;
let origEnv: Record<string, string | undefined>;

/**
 * Create a fake profiler run directory with some payload files.
 */
function createRun(
  runId: string,
  opts?: {
    sizeBytes?: number;
    manifest?: Partial<ProfilerRunManifest>;
  },
): string {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });

  // Write a payload file of the requested size
  const size = opts?.sizeBytes ?? 1024;
  writeFileSync(join(dir, "profile.cpuprofile"), Buffer.alloc(size));

  // Optionally write a pre-existing manifest
  if (opts?.manifest) {
    const m: ProfilerRunManifest = {
      runId,
      status: opts.manifest.status ?? "completed",
      createdAt: opts.manifest.createdAt ?? new Date().toISOString(),
      updatedAt: opts.manifest.updatedAt ?? new Date().toISOString(),
      totalBytes: opts.manifest.totalBytes ?? size,
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  }

  return dir;
}

function readManifestFromDisk(runId: string): ProfilerRunManifest | null {
  const manifestPath = join(runsDir, runId, "manifest.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `vellum-profiler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  runsDir = join(testDir, "data", "profiler", "runs");
  mkdirSync(runsDir, { recursive: true });

  // Save and override env
  origEnv = {
    VELLUM_WORKSPACE_DIR: process.env.VELLUM_WORKSPACE_DIR,
    VELLUM_PROFILER_RUN_ID: process.env.VELLUM_PROFILER_RUN_ID,
    VELLUM_PROFILER_MAX_BYTES: process.env.VELLUM_PROFILER_MAX_BYTES,
    VELLUM_PROFILER_MAX_RUNS: process.env.VELLUM_PROFILER_MAX_RUNS,
    VELLUM_PROFILER_MIN_FREE_MB: process.env.VELLUM_PROFILER_MIN_FREE_MB,
  };

  // Point workspace dir to our temp directory
  process.env.VELLUM_WORKSPACE_DIR = testDir;

  // Clear profiler env vars
  delete process.env.VELLUM_PROFILER_RUN_ID;
  delete process.env.VELLUM_PROFILER_MAX_BYTES;
  delete process.env.VELLUM_PROFILER_MAX_RUNS;
  delete process.env.VELLUM_PROFILER_MIN_FREE_MB;
});

afterEach(() => {
  // Restore env
  for (const [key, value] of Object.entries(origEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Clean up temp directory
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("Profiler run store", () => {
  describe("rescanRuns", () => {
    test("returns empty array when no runs directory exists", () => {
      // Remove the runs directory
      rmSync(runsDir, { recursive: true, force: true });
      const manifests = rescanRuns();
      expect(manifests).toEqual([]);
    });

    test("returns empty array when runs directory is empty", () => {
      const manifests = rescanRuns();
      expect(manifests).toEqual([]);
    });

    test("creates manifests for run directories without existing manifests", () => {
      createRun("run-001", { sizeBytes: 2048 });
      createRun("run-002", { sizeBytes: 4096 });

      const manifests = rescanRuns();
      expect(manifests).toHaveLength(2);

      const run1 = manifests.find((m) => m.runId === "run-001");
      expect(run1).toBeDefined();
      expect(run1!.status).toBe("completed");
      // totalBytes includes manifest.json that rescan just wrote
      expect(run1!.totalBytes).toBeGreaterThanOrEqual(2048);

      const run2 = manifests.find((m) => m.runId === "run-002");
      expect(run2).toBeDefined();
      expect(run2!.status).toBe("completed");
      expect(run2!.totalBytes).toBeGreaterThanOrEqual(4096);
    });

    test("marks the active run correctly", () => {
      process.env.VELLUM_PROFILER_RUN_ID = "active-run";
      createRun("active-run", { sizeBytes: 1024 });
      createRun("old-run", { sizeBytes: 1024 });

      const manifests = rescanRuns();
      const active = manifests.find((m) => m.runId === "active-run");
      const old = manifests.find((m) => m.runId === "old-run");

      expect(active!.status).toBe("active");
      expect(old!.status).toBe("completed");
    });

    test("transitions previously-active run to completed when no longer active", () => {
      // Create a run with an "active" manifest
      createRun("old-active", {
        sizeBytes: 1024,
        manifest: { status: "active", createdAt: "2025-01-01T00:00:00Z" },
      });

      // No VELLUM_PROFILER_RUN_ID set, so nothing is active
      const manifests = rescanRuns();
      const run = manifests.find((m) => m.runId === "old-active");

      expect(run!.status).toBe("completed");

      // Verify it was persisted to disk
      const onDisk = readManifestFromDisk("old-active");
      expect(onDisk!.status).toBe("completed");
    });

    test("is idempotent — repeated calls after initial scan produce the same result", () => {
      createRun("run-a", { sizeBytes: 1024 });
      process.env.VELLUM_PROFILER_RUN_ID = "run-a";

      // First call writes the manifest, which changes totalBytes
      rescanRuns();
      // Second and third calls should be stable
      const second = rescanRuns();
      const third = rescanRuns();

      expect(second).toHaveLength(1);
      expect(third).toHaveLength(1);
      expect(second[0]!.runId).toBe(third[0]!.runId);
      expect(second[0]!.status).toBe(third[0]!.status);
      expect(second[0]!.totalBytes).toBe(third[0]!.totalBytes);
    });

    test("preserves createdAt from existing manifest", () => {
      const originalCreatedAt = "2024-06-15T12:00:00Z";
      createRun("preserved-run", {
        sizeBytes: 1024,
        manifest: {
          status: "completed",
          createdAt: originalCreatedAt,
        },
      });

      const manifests = rescanRuns();
      const run = manifests.find((m) => m.runId === "preserved-run");
      expect(run!.createdAt).toBe(originalCreatedAt);
    });
  });

  describe("runProfilerSweep", () => {
    test("no-ops when no runs exist", () => {
      const result = runProfilerSweep();
      expect(result.prunedCount).toBe(0);
      expect(result.freedBytes).toBe(0);
      expect(result.activeRunOverBudget).toBe(false);
      expect(result.remainingRuns).toBe(0);
    });

    test("does not prune when under all budgets", () => {
      process.env.VELLUM_PROFILER_MAX_BYTES = "1000000"; // 1 MB
      process.env.VELLUM_PROFILER_MAX_RUNS = "10";

      createRun("run-1", { sizeBytes: 1024 });
      createRun("run-2", { sizeBytes: 1024 });

      const result = runProfilerSweep();
      expect(result.prunedCount).toBe(0);
      expect(result.remainingRuns).toBe(2);

      // Both directories still exist
      expect(existsSync(join(runsDir, "run-1"))).toBe(true);
      expect(existsSync(join(runsDir, "run-2"))).toBe(true);
    });

    test("prunes oldest completed runs when byte budget exceeded", () => {
      // Set a very small byte budget
      process.env.VELLUM_PROFILER_MAX_BYTES = "3000";
      process.env.VELLUM_PROFILER_MAX_RUNS = "100";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      // Create runs with explicit timestamps for ordering
      createRun("oldest", {
        sizeBytes: 2000,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      createRun("middle", {
        sizeBytes: 2000,
        manifest: {
          status: "completed",
          createdAt: "2025-02-01T00:00:00Z",
        },
      });
      createRun("newest", {
        sizeBytes: 2000,
        manifest: {
          status: "completed",
          createdAt: "2025-03-01T00:00:00Z",
        },
      });

      const result = runProfilerSweep();

      // Should prune until total bytes fit within 3000.
      // Each run is ~2000 payload + manifest overhead. The sweep recomputes
      // sizes so actual totals include the manifest file. At least 1 run
      // should be pruned (the oldest).
      expect(result.prunedCount).toBeGreaterThanOrEqual(1);
      expect(result.freedBytes).toBeGreaterThan(0);

      // The oldest should be gone
      expect(existsSync(join(runsDir, "oldest"))).toBe(false);
    });

    test("prunes oldest completed runs when max-run-count exceeded", () => {
      process.env.VELLUM_PROFILER_MAX_BYTES = "999999999";
      process.env.VELLUM_PROFILER_MAX_RUNS = "2";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("run-a", {
        sizeBytes: 100,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      createRun("run-b", {
        sizeBytes: 100,
        manifest: {
          status: "completed",
          createdAt: "2025-02-01T00:00:00Z",
        },
      });
      createRun("run-c", {
        sizeBytes: 100,
        manifest: {
          status: "completed",
          createdAt: "2025-03-01T00:00:00Z",
        },
      });
      createRun("run-d", {
        sizeBytes: 100,
        manifest: {
          status: "completed",
          createdAt: "2025-04-01T00:00:00Z",
        },
      });

      const result = runProfilerSweep();

      // 4 completed runs, max 2: should prune 2 oldest
      expect(result.prunedCount).toBe(2);
      expect(existsSync(join(runsDir, "run-a"))).toBe(false);
      expect(existsSync(join(runsDir, "run-b"))).toBe(false);
      expect(existsSync(join(runsDir, "run-c"))).toBe(true);
      expect(existsSync(join(runsDir, "run-d"))).toBe(true);
      expect(result.remainingRuns).toBe(2);
    });

    test("never deletes the active run", () => {
      process.env.VELLUM_PROFILER_RUN_ID = "current";
      process.env.VELLUM_PROFILER_MAX_BYTES = "500";
      process.env.VELLUM_PROFILER_MAX_RUNS = "1";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("current", { sizeBytes: 2000 });
      createRun("old-completed", {
        sizeBytes: 2000,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runProfilerSweep();

      // old-completed should be pruned, current should survive
      expect(existsSync(join(runsDir, "current"))).toBe(true);
      expect(existsSync(join(runsDir, "old-completed"))).toBe(false);
      expect(result.prunedCount).toBe(1);
    });

    test("signals active-run-over-budget when active run exceeds byte budget", () => {
      process.env.VELLUM_PROFILER_RUN_ID = "big-active";
      process.env.VELLUM_PROFILER_MAX_BYTES = "500";
      process.env.VELLUM_PROFILER_MAX_RUNS = "100";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("big-active", { sizeBytes: 10000 });

      const result = runProfilerSweep();

      expect(result.activeRunOverBudget).toBe(true);
      // Active run must still exist
      expect(existsSync(join(runsDir, "big-active"))).toBe(true);
      expect(result.remainingRuns).toBe(1);
    });

    test("deletes single oversized completed run to recover space", () => {
      process.env.VELLUM_PROFILER_MAX_BYTES = "100";
      process.env.VELLUM_PROFILER_MAX_RUNS = "100";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("huge-completed", {
        sizeBytes: 50000,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runProfilerSweep();

      expect(result.prunedCount).toBe(1);
      expect(result.freedBytes).toBeGreaterThanOrEqual(50000);
      expect(existsSync(join(runsDir, "huge-completed"))).toBe(false);
    });

    test("creates profiler directories on first sweep if missing", () => {
      // Remove everything
      rmSync(join(testDir, "data", "profiler"), {
        recursive: true,
        force: true,
      });

      const result = runProfilerSweep();
      expect(result.prunedCount).toBe(0);
      expect(existsSync(runsDir)).toBe(true);
    });

    test("sweep is idempotent — repeated calls produce consistent state", () => {
      process.env.VELLUM_PROFILER_MAX_BYTES = "999999";
      process.env.VELLUM_PROFILER_MAX_RUNS = "10";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("stable-1", { sizeBytes: 1024 });
      createRun("stable-2", { sizeBytes: 1024 });

      const first = runProfilerSweep();
      const second = runProfilerSweep();

      expect(first.prunedCount).toBe(0);
      expect(second.prunedCount).toBe(0);
      expect(first.remainingRuns).toBe(second.remainingRuns);
    });

    test("active run is not counted against max completed runs", () => {
      process.env.VELLUM_PROFILER_RUN_ID = "live";
      process.env.VELLUM_PROFILER_MAX_BYTES = "999999";
      process.env.VELLUM_PROFILER_MAX_RUNS = "2";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("live", { sizeBytes: 100 });
      createRun("done-1", {
        sizeBytes: 100,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      createRun("done-2", {
        sizeBytes: 100,
        manifest: {
          status: "completed",
          createdAt: "2025-02-01T00:00:00Z",
        },
      });

      const result = runProfilerSweep();

      // 2 completed runs = max, so nothing should be pruned
      expect(result.prunedCount).toBe(0);
      // Active + 2 completed = 3 remaining
      expect(result.remainingRuns).toBe(3);
      expect(existsSync(join(runsDir, "live"))).toBe(true);
      expect(existsSync(join(runsDir, "done-1"))).toBe(true);
      expect(existsSync(join(runsDir, "done-2"))).toBe(true);
    });
  });
});
