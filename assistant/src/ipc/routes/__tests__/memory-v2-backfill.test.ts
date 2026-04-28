/**
 * Tests for the `memory_v2/backfill` IPC route.
 *
 * The route is mutating — it inserts one `memory_jobs` row per call. We mock
 * `enqueueMemoryJob` at the module level so the tests can assert the exact
 * `(type, payload)` tuple the route forwards without standing up a real DB.
 *
 * Coverage:
 *   1. method name is the public verb expected by the CLI.
 *   2. unknown params are rejected (defensive — the schema is `.strict()`).
 *   3. each of the four ops dispatches to the correct `MemoryJobType`.
 *   4. `migrate` with `force: true` propagates the flag in the payload.
 *   5. `migrate` without `force` (and ops that ignore `force`) sends an
 *      empty payload — the `false` default never reaches the queue.
 *   6. invalid `op` values are rejected by the enum schema.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realJobsStore from "../../../memory/jobs-store.js";

// ---------------------------------------------------------------------------
// Module-level mock — capture every enqueue call so each test can assert the
// route forwarded the correct (type, payload) tuple. The route file is
// imported below the mock so it picks up this stub instead of the real one.
// ---------------------------------------------------------------------------

const enqueueCalls: Array<{
  type: string;
  payload: Record<string, unknown>;
}> = [];
let nextJobId = 0;

// Spread the real module's exports so transitive importers (e.g.
// memory/auto-analysis-enqueue.ts pulled in via the CLI program → memory
// indexer chain) get every named export they bind to at module-load time;
// only `enqueueMemoryJob` is overridden so the route under test forwards
// to the test stub. jobs-store.ts has no side-effecting top-level
// statements, so loading it for the spread is safe.
mock.module("../../../memory/jobs-store.js", () => ({
  ...realJobsStore,
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
    enqueueCalls.push({ type, payload });
    nextJobId += 1;
    return `test-job-${nextJobId}`;
  },
}));

const { ROUTES: memoryV2Routes } =
  await import("../../../runtime/routes/memory-v2-routes.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BackfillResult = { jobId: string };

const backfillRoute = memoryV2Routes.find(
  (r) => r.operationId === "memory_v2_backfill",
)!;

async function runRoute(
  params: Record<string, unknown>,
): Promise<BackfillResult> {
  return (await backfillRoute.handler({ body: params })) as BackfillResult;
}

beforeEach(() => {
  enqueueCalls.length = 0;
  nextJobId = 0;
});

afterEach(() => {
  enqueueCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_v2_backfill route", () => {
  test("operationId is 'memory_v2_backfill'", () => {
    expect(backfillRoute.operationId).toBe("memory_v2_backfill");
  });

  test("rejects unknown op", async () => {
    await expect(runRoute({ op: "wat" })).rejects.toThrow();
    expect(enqueueCalls).toEqual([]);
  });

  test("rejects unknown params", async () => {
    await expect(runRoute({ op: "migrate", extra: 1 })).rejects.toThrow();
    expect(enqueueCalls).toEqual([]);
  });

  test("rejects missing op", async () => {
    await expect(runRoute({})).rejects.toThrow();
    expect(enqueueCalls).toEqual([]);
  });

  test("migrate enqueues memory_v2_migrate with empty payload by default", async () => {
    const result = await runRoute({ op: "migrate" });

    expect(enqueueCalls).toEqual([{ type: "memory_v2_migrate", payload: {} }]);
    expect(result.jobId).toBe("test-job-1");
  });

  test("migrate with force: true propagates force in payload", async () => {
    await runRoute({ op: "migrate", force: true });

    expect(enqueueCalls).toEqual([
      { type: "memory_v2_migrate", payload: { force: true } },
    ]);
  });

  test("migrate with force: false omits force from payload", async () => {
    // We never write `force: false` because the migration runner already
    // defaults to false and a queued column should not carry a no-op flag.
    await runRoute({ op: "migrate", force: false });

    expect(enqueueCalls).toEqual([{ type: "memory_v2_migrate", payload: {} }]);
  });

  test("rebuild-edges enqueues memory_v2_rebuild_edges with empty payload", async () => {
    await runRoute({ op: "rebuild-edges" });

    expect(enqueueCalls).toEqual([
      { type: "memory_v2_rebuild_edges", payload: {} },
    ]);
  });

  test("rebuild-edges ignores force flag", async () => {
    // `force` only has meaning for `migrate`. For other ops we still accept
    // the field (so a single CLI flag works across all ops without
    // branching) but never forward it to the queue.
    await runRoute({ op: "rebuild-edges", force: true });

    expect(enqueueCalls).toEqual([
      { type: "memory_v2_rebuild_edges", payload: {} },
    ]);
  });

  test("reembed enqueues memory_v2_reembed with empty payload", async () => {
    await runRoute({ op: "reembed" });

    expect(enqueueCalls).toEqual([{ type: "memory_v2_reembed", payload: {} }]);
  });

  test("activation-recompute enqueues memory_v2_activation_recompute with empty payload", async () => {
    await runRoute({ op: "activation-recompute" });

    expect(enqueueCalls).toEqual([
      { type: "memory_v2_activation_recompute", payload: {} },
    ]);
  });

  test("returns the jobId emitted by enqueueMemoryJob", async () => {
    const first = await runRoute({ op: "rebuild-edges" });
    const second = await runRoute({ op: "reembed" });

    expect(first.jobId).toBe("test-job-1");
    expect(second.jobId).toBe("test-job-2");
  });
});
