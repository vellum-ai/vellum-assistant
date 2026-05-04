/**
 * Tests for identity/health route handlers, focusing on profiler metadata
 * in /v1/health and /v1/healthz responses.
 *
 * Proves:
 * - Backward compatibility: health endpoints return expected shape when
 *   profiler mode is off (no env vars).
 * - Profiler payload: when profiler env vars are set, the response includes
 *   a `profiler` object with the expected structure and budget state.
 * - Artifact detection: when run manifests and Bun summary files exist,
 *   the response correctly reports artifact counts and lastCompletedRun.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Silence logger before any imports that use it
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  handleDetailedHealth,
  ROUTES,
} from "../runtime/routes/identity-routes.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  getHatchedSidecarPath,
  resolveHatchedAtReadOnly,
  selectHatchedAtFromStats,
} from "../workspace/hatched-date.js";

// ── Env helpers ─────────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined>;

const PROFILER_ENV_KEYS = [
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
] as const;

function clearProfilerEnv(): void {
  for (const key of PROFILER_ENV_KEYS) {
    delete process.env[key];
  }
}

function setProfilerEnv(
  mode: string,
  runId: string,
  opts?: { maxBytes?: number; maxRuns?: number; minFreeMb?: number },
): void {
  process.env.VELLUM_PROFILER_RUN_ID = runId;
  process.env.VELLUM_PROFILER_MODE = mode;
  if (opts?.maxBytes !== undefined) {
    process.env.VELLUM_PROFILER_MAX_BYTES = String(opts.maxBytes);
  }
  if (opts?.maxRuns !== undefined) {
    process.env.VELLUM_PROFILER_MAX_RUNS = String(opts.maxRuns);
  }
  if (opts?.minFreeMb !== undefined) {
    process.env.VELLUM_PROFILER_MIN_FREE_MB = String(opts.minFreeMb);
  }
}

// ── Filesystem helpers ──────────────────────────────────────────────────

function ensureProfilerRunDir(runId: string): string {
  const wsDir = getWorkspaceDir();
  const runDir = join(wsDir, "data", "profiler", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeRunManifest(
  runId: string,
  manifest: {
    status: "active" | "completed";
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    totalBytes?: number;
  },
): void {
  const runDir = ensureProfilerRunDir(runId);
  const m: Record<string, unknown> = {
    runId,
    status: manifest.status,
    createdAt: manifest.createdAt ?? new Date().toISOString(),
    updatedAt: manifest.updatedAt ?? new Date().toISOString(),
    totalBytes: manifest.totalBytes ?? 0,
  };
  if (manifest.completedAt) {
    m.completedAt = manifest.completedAt;
  }
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(m, null, 2));
}

function writeArtifactFile(
  runId: string,
  filename: string,
  sizeBytes: number,
): void {
  const runDir = ensureProfilerRunDir(runId);
  writeFileSync(join(runDir, filename), Buffer.alloc(sizeBytes));
}

// ── Setup / teardown ────────────────────────────────────────────────────

beforeEach(() => {
  savedEnv = {};
  for (const key of PROFILER_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  clearProfilerEnv();

  // Clean up any profiler run directories from previous tests so
  // rescanRuns() doesn't pick up stale state in the shared workspace.
  const profilerRunsDir = join(getWorkspaceDir(), "data", "profiler", "runs");
  if (existsSync(profilerRunsDir)) {
    rmSync(profilerRunsDir, { recursive: true, force: true });
  }

  rmSync(getHatchedSidecarPath(), { force: true });
  rmSync(join(getWorkspaceDir(), "IDENTITY.md"), { force: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("identity routes — health endpoint", () => {
  describe("backward compatibility (profiler disabled)", () => {
    test("/v1/health returns expected shape without profiler key when env vars are absent", async () => {
      const res = handleDetailedHealth();
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("healthy");
      expect(body.timestamp).toBeDefined();
      expect(body.version).toBeDefined();
      expect(body.disk).toBeDefined();
      expect(body.memory).toBeDefined();
      expect(body.cpu).toBeDefined();
      expect(body.migrations).toBeDefined();

      // Profiler should either be absent or show enabled: false
      if ("profiler" in body) {
        const profiler = body.profiler as Record<string, unknown>;
        expect(profiler.enabled).toBe(false);
        expect(profiler.mode).toBeNull();
        expect(profiler.runId).toBeNull();
        expect(profiler.budget).toBeNull();
      }
    });

    test("/v1/healthz returns the same shape as /v1/health", async () => {
      // Both endpoints call handleDetailedHealth, so the shape must match
      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.status).toBe("healthy");
      expect(body.timestamp).toBeDefined();
      expect(body.migrations).toBeDefined();
    });
  });

  describe("profiler payload (profiler enabled)", () => {
    test("returns profiler object with enabled=true when env vars are set", async () => {
      setProfilerEnv("cpu", "run-health-test-1", {
        maxBytes: 10_000_000,
        minFreeMb: 10,
      });
      ensureProfilerRunDir("run-health-test-1");

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.profiler).toBeDefined();
      const profiler = body.profiler as Record<string, unknown>;
      expect(profiler.enabled).toBe(true);
      expect(profiler.mode).toBe("cpu");
      expect(profiler.runId).toBe("run-health-test-1");
      expect(profiler.runDir).toContain("run-health-test-1");
      expect(typeof profiler.totalBytes).toBe("number");
      expect(typeof profiler.artifactCount).toBe("number");
    });

    test("includes budget block with expected fields", async () => {
      setProfilerEnv("heap", "run-budget-test", {
        maxBytes: 50_000_000,
        minFreeMb: 100,
      });
      ensureProfilerRunDir("run-budget-test");

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const budget = profiler.budget as Record<string, unknown>;

      expect(budget).toBeDefined();
      expect(budget.maxBytes).toBe(50_000_000);
      expect(typeof budget.remainingBytes).toBe("number");
      expect(budget.minFreeMb).toBe(100);
      expect(typeof budget.freeMb).toBe("number");
      expect(typeof budget.overBudget).toBe("boolean");
    });

    test("reports artifact count from .cpuprofile files", async () => {
      setProfilerEnv("cpu", "run-artifact-count", {
        maxBytes: 100_000_000,
        minFreeMb: 0,
      });
      writeArtifactFile("run-artifact-count", "profile-1.cpuprofile", 1024);
      writeArtifactFile("run-artifact-count", "profile-2.cpuprofile", 2048);
      // Non-artifact file should not count
      writeArtifactFile("run-artifact-count", "log.txt", 512);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;

      expect(profiler.artifactCount).toBe(2);
    });

    test("detects over-budget state when total bytes exceed maxBytes", async () => {
      setProfilerEnv("cpu+heap", "run-over-budget", {
        maxBytes: 100, // Very small budget
        minFreeMb: 0,
      });
      // Write a file larger than the budget
      writeArtifactFile("run-over-budget", "big.cpuprofile", 5000);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const budget = profiler.budget as Record<string, unknown>;

      expect(budget.overBudget).toBe(true);
      expect(budget.remainingBytes).toBe(0);
    });
  });

  describe("lastCompletedRun", () => {
    test("returns null when no completed runs exist", async () => {
      setProfilerEnv("cpu", "run-no-completed", {
        maxBytes: 100_000_000,
        minFreeMb: 0,
      });
      ensureProfilerRunDir("run-no-completed");

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;

      expect(profiler.lastCompletedRun).toBeNull();
    });

    test("returns completed run summary with artifact count and hasSummaries", async () => {
      setProfilerEnv("cpu", "active-run-xyz", {
        maxBytes: 100_000_000,
        minFreeMb: 0,
      });
      ensureProfilerRunDir("active-run-xyz");

      // Create a completed run with artifacts and a summary file
      const completedId = "completed-run-abc";
      const expectedCompletedAt = "2025-06-01T00:30:00Z";
      writeRunManifest(completedId, {
        status: "completed",
        createdAt: "2025-06-01T00:00:00Z",
        updatedAt: "2025-06-01T01:00:00Z",
        completedAt: expectedCompletedAt,
        totalBytes: 4096,
      });
      writeArtifactFile(completedId, "profile.cpuprofile", 3072);
      writeArtifactFile(completedId, "summary.md", 256);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const last = profiler.lastCompletedRun as Record<string, unknown>;

      expect(last).toBeDefined();
      expect(last.runId).toBe(completedId);
      expect(last.artifactCount).toBe(1); // Only .cpuprofile counts
      expect(last.hasSummaries).toBe(true);
      expect(typeof last.totalBytes).toBe("number");
      // completedAt should reflect the manifest's completedAt value,
      // not the current time or updatedAt.
      expect(last.completedAt).toBe(expectedCompletedAt);
    });

    test("selects the most recent completed run when multiple exist", async () => {
      setProfilerEnv("heap", "active-multi", {
        maxBytes: 100_000_000,
        maxRuns: 100,
        minFreeMb: 0,
      });
      ensureProfilerRunDir("active-multi");

      writeRunManifest("older-completed", {
        status: "completed",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T01:00:00Z",
      });
      writeArtifactFile("older-completed", "old.heapsnapshot", 512);

      writeRunManifest("newer-completed", {
        status: "completed",
        createdAt: "2025-06-15T00:00:00Z",
        updatedAt: "2025-06-15T01:00:00Z",
      });
      writeArtifactFile("newer-completed", "new.heapsnapshot", 1024);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const last = profiler.lastCompletedRun as Record<string, unknown>;

      expect(last).toBeDefined();
      expect(last.runId).toBe("newer-completed");
    });
  });
});

describe("identity routes — createdAt selection", () => {
  test("falls back to mtime when birthtime is the Unix epoch", () => {
    const mtime = new Date("2026-05-01T14:49:47.519Z");

    expect(
      selectHatchedAtFromStats({
        birthtime: new Date(0),
        mtime,
      })?.toISOString(),
    ).toBe(mtime.toISOString());
  });

  test("prefers birthtime when it is valid", () => {
    const birthtime = new Date("2026-04-30T12:00:00.000Z");
    const mtime = new Date("2026-05-01T14:49:47.519Z");

    expect(
      selectHatchedAtFromStats({
        birthtime,
        mtime,
      })?.toISOString(),
    ).toBe(birthtime.toISOString());
  });

  test("returns undefined when both birthtime and mtime are the Unix epoch", () => {
    expect(
      selectHatchedAtFromStats({
        birthtime: new Date(0),
        mtime: new Date(0),
      }),
    ).toBeUndefined();
  });

  test("read-only resolver falls back to current time without writing sidecar", () => {
    const now = new Date("2026-05-04T12:00:00.000Z");

    expect(
      resolveHatchedAtReadOnly(
        join(getWorkspaceDir(), "missing-identity.md"),
        now,
      ),
    ).toBe(now.toISOString());
    expect(existsSync(getHatchedSidecarPath())).toBe(false);
  });

  test("/identity uses persisted hatched sidecar instead of live file metadata", () => {
    const workspaceDir = getWorkspaceDir();
    const dataDir = join(workspaceDir, "data");
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const persistedHatchedAt = "2026-05-01T14:49:47.519Z";

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      identityPath,
      "# Identity\n\n- **Name:** Example Assistant\n",
      "utf-8",
    );
    writeFileSync(
      getHatchedSidecarPath(),
      JSON.stringify({ hatchedAt: persistedHatchedAt }),
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity",
    );
    expect(route).toBeDefined();

    const body = route!.handler({}) as { createdAt?: string };
    expect(body.createdAt).toBe(persistedHatchedAt);
  });

  test("/identity does not write hatched sidecar on read", () => {
    const identityPath = join(getWorkspaceDir(), "IDENTITY.md");
    writeFileSync(
      identityPath,
      "# Identity\n\n- **Name:** Example Assistant\n",
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity",
    );
    expect(route).toBeDefined();

    const body = route!.handler({}) as { createdAt?: string };
    expect(Date.parse(body.createdAt ?? "")).toBeGreaterThan(0);
    expect(existsSync(getHatchedSidecarPath())).toBe(false);
  });
});
