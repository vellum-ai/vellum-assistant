import { afterAll, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import type { ReconcileAction } from "../../persistence/embeddings/reconcile-decision.js";
import {
  type ReconcileDeps,
  reconcileEmbeddingIdentity,
} from "../embedding-reconcile.js";

// Snapshot the real collaborator modules BEFORE any `mock.module` stub is
// installed in `withDefaultDepsMocks`. `mock.module` is process-global and Bun
// does not revert it (neither `mock.restore()` nor an `afterAll` re-mock) for
// test files that load LATER in the same `bun test` run — notably the v3
// `section-dense-store` suite, which imports the real module and asserts on its
// create/index call counts. So every stub below DELEGATES to the real
// implementation unless this file's default-deps tests are actively running
// (`defaultDepsMockActive`, cleared in the `afterAll` below). Mirrors
// `plugins/defaults/memory/v3/__tests__/shadow-plugin.test.ts`.
//
// Snapshot into plain objects NOW: a module namespace is a live view, so reading
// a real export AFTER its stub is installed would resolve back to the stub.
const realJobsStore = { ...(await import("../../persistence/jobs-store.js")) };
const realMemoryV3Gate = {
  ...(await import("../../config/memory-v3-gate.js")),
};
const realV2Qdrant = {
  ...(await import("../../plugins/defaults/memory/v2/qdrant.js")),
};
const realLoader = { ...(await import("../../config/loader.js")) };
const realSectionDenseStore = {
  ...(await import("../../plugins/defaults/memory/v3/section-dense-store.js")),
};

let defaultDepsMockActive = false;

afterAll(() => {
  // Deactivate the delegating stubs so sibling suites that load later in a
  // shared `bun test` process (e.g. section-dense-store.test.ts) observe the
  // real modules instead of these spies.
  defaultDepsMockActive = false;
});

/**
 * Wrap a collaborator export so it routes to `active` while this file's
 * default-deps tests run and to the real implementation otherwise. The choice is
 * made at CALL time, so the stub keeps delegating to the real module for sibling
 * suites that captured their import bindings while it was installed.
 */
function delegate<F extends (...args: never[]) => unknown>(
  active: (...args: Parameters<F>) => unknown,
  real: F,
): (...args: Parameters<F>) => unknown {
  return (...args) => (defaultDepsMockActive ? active(...args) : real(...args));
}

function fakeConfig(
  provider = "auto",
  opts: { enabled?: boolean; v2Enabled?: boolean } = {},
): AssistantConfig {
  return {
    memory: {
      enabled: opts.enabled ?? true,
      v2: { enabled: opts.v2Enabled ?? true },
      embeddings: { provider },
      qdrant: { vectorSize: 384 },
    },
  } as unknown as AssistantConfig;
}

/**
 * Build a fully-spied dep set. `decision` fixes the action the (otherwise
 * irrelevant) pure decision returns; the read primitives return the supplied
 * committed/probe dims so the orchestrator's wiring — not the decision logic,
 * which has its own unit tests — is what each case exercises.
 */
function makeDeps(opts: {
  decision: ReconcileAction;
  committedDim?: number | null;
  probeDim?: number | null;
  /** When set, `readConceptPageCollectionDim` rejects instead of resolving. */
  committedDimError?: Error;
}): ReconcileDeps {
  return {
    probeBackendDimension: mock(async () =>
      opts.probeDim == null
        ? null
        : { provider: "gemini" as const, model: "m", dim: opts.probeDim },
    ),
    readConceptPageCollectionDim: mock(async () => {
      if (opts.committedDimError) throw opts.committedDimError;
      return opts.committedDim ?? null;
    }),
    decideEmbeddingReconcile: mock(() => opts.decision),
    persistVectorSize: mock(() => {}),
    setInMemoryVectorSize: mock(() => {}),
    recreateCollectionsAtDim: mock(async () => {}),
    ensureCollections: mock(async () => {}),
    enqueueReembed: mock(() => {}),
  };
}

describe("reconcileEmbeddingIdentity", () => {
  test("defer-degraded performs ZERO destructive calls and ZERO config writes", async () => {
    const deps = makeDeps({
      decision: { kind: "defer-degraded", reason: "no reachable backend" },
      committedDim: 384,
      probeDim: null,
    });

    const outcome = await reconcileEmbeddingIdentity(fakeConfig(), deps);

    expect(outcome).toEqual({
      action: "defer-degraded",
      reason: "no reachable backend",
    });
    // Core anti-regression: nothing destructive, nothing persisted.
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(0);
    expect(deps.persistVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.setInMemoryVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.ensureCollections).toHaveBeenCalledTimes(0);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(0);
  });

  test("memory disabled short-circuits to noop with ZERO side effects", async () => {
    const deps = makeDeps({
      // The decision is irrelevant — the disabled gate returns before it runs.
      decision: { kind: "commit-fresh", dim: 3072 },
      committedDim: null,
      probeDim: 3072,
    });

    const outcome = await reconcileEmbeddingIdentity(
      fakeConfig("gemini", { enabled: false }),
      deps,
    );

    expect(outcome).toEqual({ action: "noop", dim: null });
    // Nothing is read, probed, persisted, recreated, ensured, or enqueued.
    expect(deps.probeBackendDimension).toHaveBeenCalledTimes(0);
    expect(deps.readConceptPageCollectionDim).toHaveBeenCalledTimes(0);
    expect(deps.decideEmbeddingReconcile).toHaveBeenCalledTimes(0);
    expect(deps.persistVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.setInMemoryVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(0);
    expect(deps.ensureCollections).toHaveBeenCalledTimes(0);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(0);
  });

  test("memory v2 disabled short-circuits to noop with ZERO side effects (v1 path owns its dimension)", async () => {
    const deps = makeDeps({
      // The decision is irrelevant — the v2-disabled gate returns before it runs.
      decision: { kind: "commit-fresh", dim: 3072 },
      committedDim: null,
      probeDim: 3072,
    });

    const outcome = await reconcileEmbeddingIdentity(
      fakeConfig("gemini", { v2Enabled: false }),
      deps,
    );

    expect(outcome).toEqual({ action: "noop", dim: null });
    // No v2 reembed enqueue, no probe, no dim persist that could conflict with
    // the v1 collection already initialized by the v1 startup path.
    expect(deps.probeBackendDimension).toHaveBeenCalledTimes(0);
    expect(deps.readConceptPageCollectionDim).toHaveBeenCalledTimes(0);
    expect(deps.decideEmbeddingReconcile).toHaveBeenCalledTimes(0);
    expect(deps.persistVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(0);
    expect(deps.ensureCollections).toHaveBeenCalledTimes(0);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(0);
  });

  test("a committed-dim read failure defers (degraded), never treated as fresh", async () => {
    const deps = makeDeps({
      // Even though the decision would be commit-fresh on a null committed dim,
      // the read throws first, so we must defer WITHOUT persisting/recreating.
      decision: { kind: "commit-fresh", dim: 3072 },
      committedDimError: new Error("qdrant down"),
      probeDim: 3072,
    });

    const outcome = await reconcileEmbeddingIdentity(
      fakeConfig("gemini"),
      deps,
    );

    expect(outcome).toEqual({
      action: "defer-degraded",
      reason: "could not read committed collection dimension",
    });
    // The throw short-circuits before probing and before the decision runs, so
    // nothing is persisted, recreated, ensured, or enqueued.
    expect(deps.probeBackendDimension).toHaveBeenCalledTimes(0);
    expect(deps.decideEmbeddingReconcile).toHaveBeenCalledTimes(0);
    expect(deps.persistVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.setInMemoryVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(0);
    expect(deps.ensureCollections).toHaveBeenCalledTimes(0);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(0);
  });

  test("migrate recreates collections exactly once and persists the new dim, after a non-null probe", async () => {
    const deps = makeDeps({
      decision: { kind: "migrate", fromDim: 384, toDim: 3072 },
      committedDim: 384,
      probeDim: 3072,
    });

    const outcome = await reconcileEmbeddingIdentity(
      fakeConfig("gemini"),
      deps,
    );

    expect(outcome).toEqual({ action: "migrate", fromDim: 384, toDim: 3072 });
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(1);
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledWith(3072);
    expect(deps.persistVectorSize).toHaveBeenCalledTimes(1);
    expect(deps.persistVectorSize).toHaveBeenCalledWith(3072);
    expect(deps.setInMemoryVectorSize).toHaveBeenCalledWith(3072);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(1);
    // Migrate does NOT use the create-if-absent path.
    expect(deps.ensureCollections).toHaveBeenCalledTimes(0);
    // Probe was confirmed reachable before any destructive call.
    expect(deps.probeBackendDimension).toHaveBeenCalledTimes(1);
  });

  test("migrate rolls back the committed dimension when the recreate throws", async () => {
    const deps = makeDeps({
      decision: { kind: "migrate", fromDim: 384, toDim: 3072 },
      committedDim: 384,
      probeDim: 3072,
    });
    // The destructive recreate fails mid-migration (e.g. a transient Qdrant error).
    deps.recreateCollectionsAtDim = mock(async () => {
      throw new Error("qdrant recreate failed");
    });

    await expect(
      reconcileEmbeddingIdentity(fakeConfig("gemini"), deps),
    ).rejects.toThrow("qdrant recreate failed");

    // The new dim is committed for the recreate, then rolled back to the old dim
    // so config stays consistent with the still-existing old collection; the
    // next reconcile re-migrates from a consistent state.
    expect(deps.persistVectorSize).toHaveBeenNthCalledWith(1, 3072);
    expect(deps.persistVectorSize).toHaveBeenNthCalledWith(2, 384);
    expect(deps.setInMemoryVectorSize).toHaveBeenNthCalledWith(2, 384);
    // No reembed is enqueued when the recreate failed.
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(0);
  });

  test("commit-fresh persists and ensures-without-destroy, never recreates", async () => {
    const deps = makeDeps({
      decision: { kind: "commit-fresh", dim: 3072 },
      committedDim: null,
      probeDim: 3072,
    });

    const outcome = await reconcileEmbeddingIdentity(
      fakeConfig("gemini"),
      deps,
    );

    expect(outcome).toEqual({ action: "commit-fresh", dim: 3072 });
    expect(deps.persistVectorSize).toHaveBeenCalledWith(3072);
    expect(deps.setInMemoryVectorSize).toHaveBeenCalledWith(3072);
    expect(deps.ensureCollections).toHaveBeenCalledTimes(1);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(1);
    // Commit-fresh must never destroy.
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(0);
  });

  test("noop writes nothing and returns the committed dim", async () => {
    const deps = makeDeps({
      decision: { kind: "noop" },
      committedDim: 384,
      probeDim: 384,
    });

    const outcome = await reconcileEmbeddingIdentity(fakeConfig(), deps);

    expect(outcome).toEqual({ action: "noop", dim: 384 });
    expect(deps.persistVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.setInMemoryVectorSize).toHaveBeenCalledTimes(0);
    expect(deps.recreateCollectionsAtDim).toHaveBeenCalledTimes(0);
    expect(deps.ensureCollections).toHaveBeenCalledTimes(0);
    expect(deps.enqueueReembed).toHaveBeenCalledTimes(0);
  });

  test("passes committed + probe dims and configured provider into the decision", async () => {
    const deps = makeDeps({
      decision: { kind: "noop" },
      committedDim: 384,
      probeDim: 768,
    });

    await reconcileEmbeddingIdentity(fakeConfig("voyage"), deps);

    expect(deps.decideEmbeddingReconcile).toHaveBeenCalledWith({
      committedDim: 384,
      probeDim: 768,
      configuredProvider: "voyage",
    });
  });
});

// ---------------------------------------------------------------------------
// Default side-effecting deps: v2-reembed dedup + v3 section-collection gating
// ---------------------------------------------------------------------------
//
// These build the real `defaultDeps` and override ONLY the read primitives +
// decision so the production side-effecting wiring (config write, collection
// ensure/recreate, reembed enqueue) runs against mocked collaborator modules —
// asserting the enqueue dedup and the `isMemoryV3Live` gate on the v3
// section-collection lifecycle without touching Qdrant, a backend, or config I/O.

/**
 * Install the collaborator-module stubs `defaultDeps` pulls in, then re-import
 * the module under test so its default deps close over them. Returns the spies
 * plus a `defaultDeps` factory bound to the re-imported module.
 *
 * Each stub DELEGATES to the real module unless this file's default-deps tests
 * are actively running (`defaultDepsMockActive`, set here and cleared in the
 * file-level `afterAll`), so the process-global `mock.module` overrides do not
 * leak into sibling suites that load later in the same `bun test` run. The
 * delegation is decided at CALL time, so it stays correct regardless of when a
 * later file captured its import bindings.
 */
async function withDefaultDepsMocks(opts: {
  v3Live: boolean;
  pendingTypes?: ReadonlyArray<string>;
}) {
  const pending = new Set(opts.pendingTypes ?? []);
  const spies = {
    enqueueMemoryJob: mock(() => "job-id"),
    hasActiveJobOfType: mock((type: string) => pending.has(type)),
    ensureSectionCollection: mock(async () => {}),
    recreateSectionCollection: mock(async () => {}),
    ensureConceptPageCollection: mock(async () => ({ migrated: false })),
    recreateConceptPageCollection: mock(async () => {}),
  };

  defaultDepsMockActive = true;

  mock.module("../../persistence/jobs-store.js", () => ({
    ...realJobsStore,
    enqueueMemoryJob: delegate(
      spies.enqueueMemoryJob,
      realJobsStore.enqueueMemoryJob,
    ),
    hasActiveJobOfType: delegate(
      spies.hasActiveJobOfType,
      realJobsStore.hasActiveJobOfType,
    ),
  }));
  mock.module("../../config/memory-v3-gate.js", () => ({
    ...realMemoryV3Gate,
    isMemoryV3Live: delegate(
      () => opts.v3Live,
      realMemoryV3Gate.isMemoryV3Live,
    ),
  }));
  mock.module("../../plugins/defaults/memory/v2/qdrant.js", () => ({
    ...realV2Qdrant,
    ensureConceptPageCollection: delegate(
      spies.ensureConceptPageCollection,
      realV2Qdrant.ensureConceptPageCollection,
    ),
    recreateConceptPageCollection: delegate(
      spies.recreateConceptPageCollection,
      realV2Qdrant.recreateConceptPageCollection,
    ),
  }));
  mock.module("../../config/loader.js", () => ({
    ...realLoader,
    loadRawConfig: delegate(() => ({}), realLoader.loadRawConfig),
    saveRawConfig: delegate(() => undefined, realLoader.saveRawConfig),
    setNestedValue: delegate(() => undefined, realLoader.setNestedValue),
    invalidateConfigCache: delegate(
      () => undefined,
      realLoader.invalidateConfigCache,
    ),
  }));
  mock.module(
    "../../plugins/defaults/memory/v3/section-dense-store.js",
    () => ({
      ...realSectionDenseStore,
      ensureSectionCollection: delegate(
        spies.ensureSectionCollection,
        realSectionDenseStore.ensureSectionCollection,
      ),
      recreateSectionCollection: delegate(
        spies.recreateSectionCollection,
        realSectionDenseStore.recreateSectionCollection,
      ),
    }),
  );

  const mod = await import("../embedding-reconcile.js");
  return {
    spies,
    reconcile: mod.reconcileEmbeddingIdentity,
    defaultDeps: mod.defaultDeps,
  };
}

/** Read-primitive + decision overrides that drive a chosen branch. */
function driveBranch(
  decision: ReconcileAction,
  committedDim: number | null,
): Partial<ReconcileDeps> {
  return {
    probeBackendDimension: mock(async () => ({
      provider: "gemini" as const,
      model: "m",
      dim: 3072,
    })),
    readConceptPageCollectionDim: mock(async () => committedDim),
    decideEmbeddingReconcile: mock(() => decision),
  };
}

describe("reconcileEmbeddingIdentity default side-effecting deps", () => {
  test("v2 reembed enqueue dedups against an already-pending reembed", async () => {
    const config = fakeConfig("gemini");

    // No pending reembed: enqueues exactly once.
    const first = await withDefaultDepsMocks({ v3Live: false });
    await first.reconcile(config, {
      ...first.defaultDeps(config),
      ...driveBranch({ kind: "commit-fresh", dim: 3072 }, null),
    });
    expect(first.spies.enqueueMemoryJob).toHaveBeenCalledTimes(1);
    expect(first.spies.enqueueMemoryJob).toHaveBeenCalledWith(
      "memory_v2_reembed",
      {},
    );

    // A reembed is already pending: a second reconcile must not enqueue again.
    const second = await withDefaultDepsMocks({
      v3Live: false,
      pendingTypes: ["memory_v2_reembed"],
    });
    await second.reconcile(config, {
      ...second.defaultDeps(config),
      ...driveBranch({ kind: "commit-fresh", dim: 3072 }, null),
    });
    expect(second.spies.enqueueMemoryJob).toHaveBeenCalledTimes(0);
  });

  test("commit-fresh skips the v3 section ensure when v3 is not live", async () => {
    const config = fakeConfig("gemini");
    const { spies, reconcile, defaultDeps } = await withDefaultDepsMocks({
      v3Live: false,
    });

    await reconcile(config, {
      ...defaultDeps(config),
      ...driveBranch({ kind: "commit-fresh", dim: 3072 }, null),
    });

    expect(spies.ensureConceptPageCollection).toHaveBeenCalledTimes(1);
    expect(spies.ensureSectionCollection).toHaveBeenCalledTimes(0);
  });

  test("commit-fresh ensures the v3 section collection when v3 is live", async () => {
    const config = fakeConfig("gemini");
    const { spies, reconcile, defaultDeps } = await withDefaultDepsMocks({
      v3Live: true,
    });

    await reconcile(config, {
      ...defaultDeps(config),
      ...driveBranch({ kind: "commit-fresh", dim: 3072 }, null),
    });

    expect(spies.ensureConceptPageCollection).toHaveBeenCalledTimes(1);
    expect(spies.ensureSectionCollection).toHaveBeenCalledTimes(1);
  });

  test("migrate skips the v3 section recreate when v3 is not live", async () => {
    const config = fakeConfig("gemini");
    const { spies, reconcile, defaultDeps } = await withDefaultDepsMocks({
      v3Live: false,
    });

    await reconcile(config, {
      ...defaultDeps(config),
      ...driveBranch({ kind: "migrate", fromDim: 384, toDim: 3072 }, 384),
    });

    expect(spies.recreateConceptPageCollection).toHaveBeenCalledTimes(1);
    expect(spies.recreateSectionCollection).toHaveBeenCalledTimes(0);
  });

  test("migrate recreates the v3 section collection when v3 is live", async () => {
    const config = fakeConfig("gemini");
    const { spies, reconcile, defaultDeps } = await withDefaultDepsMocks({
      v3Live: true,
    });

    await reconcile(config, {
      ...defaultDeps(config),
      ...driveBranch({ kind: "migrate", fromDim: 384, toDim: 3072 }, 384),
    });

    expect(spies.recreateConceptPageCollection).toHaveBeenCalledTimes(1);
    expect(spies.recreateSectionCollection).toHaveBeenCalledTimes(1);
  });

  test("migrate does not roll back when only the v3 recreate fails (v2 already rebuilt)", async () => {
    const config = fakeConfig("gemini");
    const { spies, reconcile, defaultDeps } = await withDefaultDepsMocks({
      v3Live: true,
    });
    // v2 rebuilds successfully; the v3 section recreate then throws.
    spies.recreateSectionCollection.mockImplementation(async () => {
      throw new Error("v3 recreate failed");
    });

    // The reconcile must NOT reject: v2 is rebuilt at the new dimension, so the
    // v3 failure is swallowed (v3 self-heals via its lazy recreate + maintain)
    // rather than rolling the committed dimension back below the rebuilt v2.
    await reconcile(config, {
      ...defaultDeps(config),
      ...driveBranch({ kind: "migrate", fromDim: 384, toDim: 3072 }, 384),
    });

    expect(spies.recreateConceptPageCollection).toHaveBeenCalledTimes(1);
    expect(spies.recreateSectionCollection).toHaveBeenCalledTimes(1);
    // Reaching the reembed enqueue proves the migrate completed without the
    // rollback/re-throw a propagated v3 failure would have triggered.
    expect(spies.enqueueMemoryJob).toHaveBeenCalledWith(
      "memory_v2_reembed",
      {},
    );
  });
});
