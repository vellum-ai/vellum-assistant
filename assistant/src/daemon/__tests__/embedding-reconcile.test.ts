import { describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import type { ReconcileAction } from "../../persistence/embeddings/reconcile-decision.js";
import {
  type ReconcileDeps,
  reconcileEmbeddingIdentity,
} from "../embedding-reconcile.js";

function fakeConfig(provider = "auto"): AssistantConfig {
  return {
    memory: {
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
}): ReconcileDeps {
  return {
    probeBackendDimension: mock(async () =>
      opts.probeDim == null
        ? null
        : { provider: "gemini" as const, model: "m", dim: opts.probeDim },
    ),
    readConceptPageCollectionDim: mock(async () => opts.committedDim ?? null),
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
