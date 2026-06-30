import { describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import type { ReconcileAction } from "../../persistence/embeddings/reconcile-decision.js";
import {
  type ReconcileDeps,
  reconcileEmbeddingIdentity,
} from "../embedding-reconcile.js";

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
 * Reset and re-install the mocks for the collaborator modules `defaultDeps`
 * pulls in, then re-import the module under test so its default deps close over
 * the freshly-mocked collaborators. Returns the spies plus a `defaultDeps`
 * factory bound to the re-imported module.
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

  mock.module("../../persistence/jobs-store.js", () => ({
    enqueueMemoryJob: spies.enqueueMemoryJob,
    hasActiveJobOfType: spies.hasActiveJobOfType,
  }));
  mock.module("../../config/memory-v3-gate.js", () => ({
    isMemoryV3Live: () => opts.v3Live,
  }));
  mock.module("../../memory/v2/qdrant.js", () => ({
    ensureConceptPageCollection: spies.ensureConceptPageCollection,
    recreateConceptPageCollection: spies.recreateConceptPageCollection,
  }));
  mock.module("../../config/loader.js", () => ({
    loadRawConfig: () => ({}),
    saveRawConfig: () => {},
    setNestedValue: () => {},
    invalidateConfigCache: () => {},
  }));
  mock.module(
    "../../plugins/defaults/memory/v3/section-dense-store.js",
    () => ({
      ensureSectionCollection: spies.ensureSectionCollection,
      recreateSectionCollection: spies.recreateSectionCollection,
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
});
