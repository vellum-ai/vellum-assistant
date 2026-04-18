/**
 * Tests for profiler HTTP route handlers: empty-state listings, missing-run
 * 404s, active-run delete rejection, tarball export success, archive failure
 * when a run directory exceeds the configured bundle size cap, and post-delete
 * budget recalculation.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProfilerRunManifest } from "../daemon/profiler-run-store.js";
import type { AuthContext } from "../runtime/auth/types.js";
import type { RouteContext, RouteParams } from "../runtime/http-router.js";
import { profilerRouteDefinitions } from "../runtime/routes/profiler-routes.js";

// ── Test scaffolding ────────────────────────────────────────────────────

let testDir: string;
let runsDir: string;
let origEnv: Record<string, string | undefined>;

const routes = profilerRouteDefinitions();

function findRoute(
  endpoint: string,
  method: string,
): (typeof routes)[number] | undefined {
  return routes.find((r) => r.endpoint === endpoint && r.method === method);
}

/**
 * Build a minimal RouteContext for testing route handlers.
 */
function makeCtx(
  params: RouteParams = {},
  method: string = "GET",
): RouteContext {
  return {
    req: new Request("http://localhost:7821/v1/profiler/runs", { method }),
    url: new URL("http://localhost:7821/v1/profiler/runs"),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {
      subject: "svc:gateway:self",
      principalType: "svc_gateway",
      assistantId: "self",
      scopeProfile: "gateway_service_v1",
      scopes: new Set(["internal.write"]),
      policyEpoch: 1,
    } as AuthContext,
    params,
  };
}

/**
 * Create a fake profiler run directory with some payload files.
 */
function createRun(
  runId: string,
  opts?: {
    sizeBytes?: number;
    manifest?: Partial<ProfilerRunManifest>;
    markdownSummary?: string;
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

  // Optionally write a markdown summary
  if (opts?.markdownSummary) {
    writeFileSync(join(dir, "profile-summary.md"), opts.markdownSummary);
  }

  return dir;
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `vellum-profiler-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("Profiler routes", () => {
  describe("GET /v1/profiler/runs (list)", () => {
    test("returns empty list when no runs exist", async () => {
      const route = findRoute("profiler/runs", "GET")!;
      const response = await route.handler(makeCtx());
      const body = (await response.json()) as {
        runs: unknown[];
        totalRuns: number;
        activeRunId: string | null;
      };

      expect(response.status).toBe(200);
      expect(body.runs).toEqual([]);
      expect(body.totalRuns).toBe(0);
      expect(body.activeRunId).toBeNull();
    });

    test("returns runs sorted newest-first", async () => {
      createRun("old-run", {
        sizeBytes: 1024,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      createRun("new-run", {
        sizeBytes: 1024,
        manifest: {
          status: "completed",
          createdAt: "2025-06-01T00:00:00Z",
        },
      });

      const route = findRoute("profiler/runs", "GET")!;
      const response = await route.handler(makeCtx());
      const body = (await response.json()) as {
        runs: ProfilerRunManifest[];
        totalRuns: number;
      };

      expect(response.status).toBe(200);
      expect(body.totalRuns).toBe(2);
      expect(body.runs[0]!.runId).toBe("new-run");
      expect(body.runs[1]!.runId).toBe("old-run");
    });

    test("reports active run ID when set", async () => {
      process.env.VELLUM_PROFILER_RUN_ID = "active-run";
      createRun("active-run", { sizeBytes: 512 });

      const route = findRoute("profiler/runs", "GET")!;
      const response = await route.handler(makeCtx());
      const body = (await response.json()) as {
        activeRunId: string | null;
      };

      expect(body.activeRunId).toBe("active-run");
    });
  });

  describe("path traversal rejection", () => {
    const traversalPayloads = [
      "../../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "foo/bar",
      "foo\\bar",
      "..\\..\\windows",
    ];

    for (const payload of traversalPayloads) {
      test(`GET rejects runId "${payload}"`, async () => {
        const route = findRoute("profiler/runs/:runId", "GET")!;
        const response = await route.handler(makeCtx({ runId: payload }));
        expect(response.status).toBe(400);
      });

      test(`POST export rejects runId "${payload}"`, async () => {
        const route = findRoute("profiler/runs/:runId/export", "POST")!;
        const response = await route.handler(
          makeCtx({ runId: payload }, "POST"),
        );
        expect(response.status).toBe(400);
      });

      test(`DELETE rejects runId "${payload}"`, async () => {
        const route = findRoute("profiler/runs/:runId", "DELETE")!;
        const response = await route.handler(
          makeCtx({ runId: payload }, "DELETE"),
        );
        expect(response.status).toBe(400);
      });
    }
  });

  describe("GET /v1/profiler/runs/:runId (detail)", () => {
    test("returns 404 for missing run", async () => {
      const route = findRoute("profiler/runs/:runId", "GET")!;
      const response = await route.handler(makeCtx({ runId: "nonexistent" }));

      expect(response.status).toBe(404);
      const body = (await response.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("NOT_FOUND");
    });

    test("returns manifest metadata and markdown summary", async () => {
      createRun("run-with-summary", {
        sizeBytes: 2048,
        manifest: {
          status: "completed",
          createdAt: "2025-03-15T10:00:00Z",
        },
        markdownSummary: "# CPU Profile\n\nTop functions by self-time...",
      });

      const route = findRoute("profiler/runs/:runId", "GET")!;
      const response = await route.handler(
        makeCtx({ runId: "run-with-summary" }),
      );
      const body = (await response.json()) as {
        runId: string;
        status: string;
        summary: string | null;
        isActive: boolean;
      };

      expect(response.status).toBe(200);
      expect(body.runId).toBe("run-with-summary");
      expect(body.status).toBe("completed");
      expect(body.summary).toContain("CPU Profile");
      expect(body.isActive).toBe(false);
    });

    test("returns null summary when no markdown file exists", async () => {
      createRun("run-no-summary", {
        sizeBytes: 1024,
        manifest: { status: "completed" },
      });

      const route = findRoute("profiler/runs/:runId", "GET")!;
      const response = await route.handler(
        makeCtx({ runId: "run-no-summary" }),
      );
      const body = (await response.json()) as {
        summary: string | null;
      };

      expect(response.status).toBe(200);
      expect(body.summary).toBeNull();
    });

    test("marks active run correctly", async () => {
      process.env.VELLUM_PROFILER_RUN_ID = "live-run";
      createRun("live-run", {
        sizeBytes: 1024,
        manifest: { status: "active" },
      });

      const route = findRoute("profiler/runs/:runId", "GET")!;
      const response = await route.handler(makeCtx({ runId: "live-run" }));
      const body = (await response.json()) as {
        isActive: boolean;
      };

      expect(response.status).toBe(200);
      expect(body.isActive).toBe(true);
    });
  });

  describe("POST /v1/profiler/runs/:runId/export", () => {
    test("returns 404 for missing run", async () => {
      const route = findRoute("profiler/runs/:runId/export", "POST")!;
      const response = await route.handler(
        makeCtx({ runId: "nonexistent" }, "POST"),
      );

      expect(response.status).toBe(404);
    });

    test("returns tar.gz for a valid run", async () => {
      createRun("exportable-run", {
        sizeBytes: 512,
        manifest: { status: "completed" },
      });

      const route = findRoute("profiler/runs/:runId/export", "POST")!;
      const response = await route.handler(
        makeCtx({ runId: "exportable-run" }, "POST"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/gzip");
      expect(response.headers.get("Content-Disposition")).toContain(
        "profiler-exportable-run.tar.gz",
      );

      const arrayBuffer = await response.arrayBuffer();
      expect(arrayBuffer.byteLength).toBeGreaterThan(0);
    });

    test("returns 500 when archive exceeds size limit", async () => {
      // Create a run with a very large file that will exceed the 50MB archive cap.
      // We mock this by creating a run directory and writing enough data to push
      // past the limit. Since createTarGz uses MAX_ARCHIVE_BYTES as the maxBuffer,
      // a large-enough payload will trigger the failure path.
      const runDir = join(runsDir, "huge-run");
      mkdirSync(runDir, { recursive: true });

      // Write manifest so the route can find the run
      const manifest: ProfilerRunManifest = {
        runId: "huge-run",
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalBytes: 60 * 1024 * 1024,
      };
      writeFileSync(
        join(runDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );

      // Write a file large enough that the compressed tar exceeds 50MB.
      // Random data doesn't compress well, so 55MB of random data should
      // produce a tar.gz larger than 50MB.
      const chunkSize = 1024 * 1024; // 1 MB
      const chunks = 55;
      for (let i = 0; i < chunks; i++) {
        const buf = Buffer.alloc(chunkSize);
        // Fill with pseudo-random data to defeat compression
        for (let j = 0; j < chunkSize; j += 4) {
          buf.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, j);
        }
        writeFileSync(join(runDir, `chunk-${i}.bin`), buf);
      }

      const route = findRoute("profiler/runs/:runId/export", "POST")!;
      const response = await route.handler(
        makeCtx({ runId: "huge-run" }, "POST"),
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).toContain("archive size");
    }, 30_000);
  });

  describe("DELETE /v1/profiler/runs/:runId", () => {
    test("returns 404 for missing run", async () => {
      const route = findRoute("profiler/runs/:runId", "DELETE")!;
      const response = await route.handler(
        makeCtx({ runId: "nonexistent" }, "DELETE"),
      );

      expect(response.status).toBe(404);
    });

    test("rejects deletion of the currently active run", async () => {
      process.env.VELLUM_PROFILER_RUN_ID = "active-run";
      createRun("active-run", {
        sizeBytes: 1024,
        manifest: { status: "active" },
      });

      const route = findRoute("profiler/runs/:runId", "DELETE")!;
      const response = await route.handler(
        makeCtx({ runId: "active-run" }, "DELETE"),
      );

      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("CONFLICT");

      // Run directory should still exist
      expect(existsSync(join(runsDir, "active-run"))).toBe(true);
    });

    test("deletes a completed run and returns budget state", async () => {
      process.env.VELLUM_PROFILER_MAX_BYTES = "999999999";
      process.env.VELLUM_PROFILER_MAX_RUNS = "100";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      createRun("completed-run", {
        sizeBytes: 2048,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      createRun("other-run", {
        sizeBytes: 1024,
        manifest: {
          status: "completed",
          createdAt: "2025-02-01T00:00:00Z",
        },
      });

      const route = findRoute("profiler/runs/:runId", "DELETE")!;
      const response = await route.handler(
        makeCtx({ runId: "completed-run" }, "DELETE"),
      );
      const body = (await response.json()) as {
        deleted: boolean;
        runId: string;
        remainingRuns: number;
        activeRunOverBudget: boolean;
      };

      expect(response.status).toBe(200);
      expect(body.deleted).toBe(true);
      expect(body.runId).toBe("completed-run");
      expect(body.remainingRuns).toBe(1);
      expect(body.activeRunOverBudget).toBe(false);

      // Run directory should be gone
      expect(existsSync(join(runsDir, "completed-run"))).toBe(false);
      // Other run should still exist
      expect(existsSync(join(runsDir, "other-run"))).toBe(true);
    });

    test("post-delete budget recalculation reflects freed space", async () => {
      process.env.VELLUM_PROFILER_MAX_BYTES = "5000";
      process.env.VELLUM_PROFILER_MAX_RUNS = "100";
      process.env.VELLUM_PROFILER_MIN_FREE_MB = "0";

      // Create two runs that together exceed the 5000 byte budget
      createRun("over-budget-a", {
        sizeBytes: 3000,
        manifest: {
          status: "completed",
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      createRun("over-budget-b", {
        sizeBytes: 3000,
        manifest: {
          status: "completed",
          createdAt: "2025-02-01T00:00:00Z",
        },
      });

      // Delete one of the runs
      const route = findRoute("profiler/runs/:runId", "DELETE")!;
      const response = await route.handler(
        makeCtx({ runId: "over-budget-a" }, "DELETE"),
      );
      const body = (await response.json()) as {
        deleted: boolean;
        remainingRuns: number;
      };

      expect(response.status).toBe(200);
      expect(body.deleted).toBe(true);
      // The remaining run should survive since it's within budget now
      expect(body.remainingRuns).toBe(1);
      expect(existsSync(join(runsDir, "over-budget-b"))).toBe(true);
    });
  });
});
