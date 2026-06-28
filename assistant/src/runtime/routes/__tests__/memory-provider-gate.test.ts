/**
 * Tests for the memory v2/v3 maintenance-route gating.
 *
 * The v2/v3 route modules live in the shared ROUTES array and are always
 * registered. The gating split:
 *
 *  - v3 routes gate on the *active provider* — they report not-applicable
 *    (404) when v3 is not the derived provider.
 *  - v2 routes gate on `memory.v2.enabled` (the corpus exists and is
 *    maintained), NOT on the active provider. A v3-live install still
 *    maintains its live v2 concept-page corpus (`v2.enabled` stays true), so
 *    its v2 maintenance/read verbs must keep working. The 409 +
 *    `MEMORY_V2_DISABLED` fires only when v2 is genuinely disabled.
 *
 * The active provider / `v2.enabled` are derived from a per-test workspace
 * `config.json` via the real `loadConfig`.
 *
 * The v3 `backfill-sections` body is heavy (embeds every page), so its one
 * underlying call is stubbed (preserving the module's other exports) — the
 * gate runs before that work, so a gated call must reject without ever
 * touching it. `invalidateLanes` (the rebuild-index body) is a cheap in-memory
 * op and runs unmocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { invalidateConfigCache } from "../../../config/loader.js";

// ─── stub the heavy v3 backfill body (must precede route import) ─────────────

let backfillCalls = 0;

const maintainJobActual =
  await import("../../../plugins/defaults/memory-v3-shadow/maintain-job.js");
mock.module(
  "../../../plugins/defaults/memory-v3-shadow/maintain-job.js",
  () => ({
    ...maintainJobActual,
    backfillAllSections: async () => {
      backfillCalls += 1;
      return { articles: 0, sections: 0, failures: 0 };
    },
  }),
);

const { ROUTES: memoryV2Routes, MEMORY_V2_DISABLED_CODE } =
  await import("../memory-v2-routes.js");
const { ROUTES: memoryV3Routes } = await import("../memory-v3-routes.js");
const { MEMORY_PROVIDER_NOT_ACTIVE_CODE } =
  await import("../memory-provider-gate.js");
const { RouteError } = await import("../errors.js");
const { ROUTES } = await import("../index.js");

// ─── helpers ─────────────────────────────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

function writeWorkspaceConfig(json: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(json, null, 2),
    "utf-8",
  );
  invalidateConfigCache();
}

function findRoute(
  routes: typeof memoryV2Routes,
  operationId: string,
): (typeof memoryV2Routes)[number] {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

/** Provider-pinned config helpers. `v2.enabled` defaults to true. */
const asV2 = () => writeWorkspaceConfig({ memory: { provider: "v2" } });
const asV3 = () => writeWorkspaceConfig({ memory: { provider: "v3" } });
/** v3 active with the v2 corpus explicitly disabled. */
const asV3WithV2Disabled = () =>
  writeWorkspaceConfig({
    memory: { provider: "v3", v2: { enabled: false } },
  });

beforeEach(() => {
  backfillCalls = 0;
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-mem-provider-gate-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  invalidateConfigCache();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  invalidateConfigCache();
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── shared aggregator contract ──────────────────────────────────────────────

describe("shared ROUTES still register both memory route families", () => {
  test("v2 and v3 routes are present in the aggregated ROUTES array", () => {
    const ids = new Set(ROUTES.map((r) => r.operationId));
    expect(ids.has("memory_v2_backfill")).toBe(true);
    expect(ids.has("memory_v3_rebuild_index")).toBe(true);
    expect(ids.has("memory_v3_backfill_sections")).toBe(true);
  });
});

// ─── provider = v2 ───────────────────────────────────────────────────────────

describe("with provider = v2", () => {
  test("v2 maintenance routes execute", async () => {
    asV2();
    // list-concept-pages reads the on-disk workspace (no DB), so a passing
    // gate yields the empty-workspace listing rather than the not-active error.
    const route = findRoute(memoryV2Routes, "memory_v2_list_concept_pages");
    const result = (await route.handler({ body: {} })) as {
      pages: unknown[];
    };
    expect(result.pages).toEqual([]);
  });

  test("v3 routes report not-applicable (404), without running their body", async () => {
    asV2();
    const route = findRoute(memoryV3Routes, "memory_v3_rebuild_index");
    try {
      await route.handler({ body: {} });
      throw new Error("expected handler to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      const e = err as InstanceType<typeof RouteError>;
      expect(e.code).toBe(MEMORY_PROVIDER_NOT_ACTIVE_CODE);
      expect(e.statusCode).toBe(404);
    }
  });

  test("v3 backfill-sections reports not-applicable without embedding", async () => {
    asV2();
    const route = findRoute(memoryV3Routes, "memory_v3_backfill_sections");
    await expect(route.handler({ body: {} })).rejects.toBeInstanceOf(
      RouteError,
    );
    expect(backfillCalls).toBe(0);
  });
});

// ─── provider = v3 ───────────────────────────────────────────────────────────

describe("with provider = v3", () => {
  test("v3 maintenance routes execute", async () => {
    asV3();
    const rebuild = findRoute(memoryV3Routes, "memory_v3_rebuild_index");
    const result = (await rebuild.handler({ body: {} })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const backfill = findRoute(memoryV3Routes, "memory_v3_backfill_sections");
    await backfill.handler({ body: {} });
    expect(backfillCalls).toBe(1);
  });

  test("v2 maintenance routes still execute (v2.enabled stays true under v3)", async () => {
    asV3();
    // The v2 corpus is still maintained on a v3-live install, so its
    // read/maintenance verbs must keep working. list-concept-pages reads the
    // on-disk workspace (no DB); a passing gate yields the empty-workspace
    // listing rather than a disabled error.
    const route = findRoute(memoryV2Routes, "memory_v2_list_concept_pages");
    const result = (await route.handler({ body: {} })) as {
      pages: unknown[];
    };
    expect(result.pages).toEqual([]);
  });
});

// ─── v2 corpus disabled ───────────────────────────────────────────────────────

describe("with memory.v2.enabled = false", () => {
  test("v2 routes report disabled (409 + MEMORY_V2_DISABLED)", async () => {
    asV3WithV2Disabled();
    const route = findRoute(memoryV2Routes, "memory_v2_backfill");
    try {
      await route.handler({ body: { op: "migrate" } });
      throw new Error("expected handler to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      const e = err as InstanceType<typeof RouteError>;
      expect(e.code).toBe(MEMORY_V2_DISABLED_CODE);
      expect(e.statusCode).toBe(409);
    }
  });
});
