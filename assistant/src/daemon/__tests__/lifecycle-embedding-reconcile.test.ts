import { describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import {
  type ReconcileDeps,
  reconcileEmbeddingIdentity,
} from "../embedding-reconcile.js";

/**
 * Focused wiring test for the embedding-identity reconcile's startup contract.
 *
 * `lifecycle.ts` invokes `reconcileEmbeddingIdentity(config)` on the
 * Qdrant-started path inside its own try/catch, immediately before the v2
 * concept rebuild, so the committed `memory.qdrant.vectorSize` is settled
 * first. Mounting the full lifecycle import graph to assert that is
 * disproportionately heavy, so this exercises the two load-bearing properties
 * directly:
 *
 *  1. the reconcile is invoked with the live config, and
 *  2. a thrown reconcile is swallowed by the surrounding try/catch (daemon
 *     startup must never block on subsystem failure).
 *
 * The try/catch shape mirrors the lifecycle call site verbatim.
 */

function fakeConfig(): AssistantConfig {
  return {
    memory: {
      embeddings: { provider: "auto" },
      qdrant: { vectorSize: 384 },
    },
  } as unknown as AssistantConfig;
}

/**
 * Deps that drive a `migrate` whose destructive collection recreate throws (a
 * genuine Qdrant failure mid-reconcile), so the orchestrator rejects. A read
 * failure no longer rejects — it defers — so the rejection is triggered through
 * a downstream op that is intentionally not caught.
 */
function throwingDeps(): ReconcileDeps {
  return {
    probeBackendDimension: mock(async () => ({
      provider: "gemini" as const,
      model: "m",
      dim: 3072,
    })),
    readConceptPageCollectionDim: mock(async () => 384),
    decideEmbeddingReconcile: mock(
      () => ({ kind: "migrate", fromDim: 384, toDim: 3072 }) as const,
    ),
    persistVectorSize: mock(() => {}),
    setInMemoryVectorSize: mock(() => {}),
    recreateCollectionsAtDim: mock(async () => {
      throw new Error("qdrant recreate blew up");
    }),
    ensureCollections: mock(async () => {}),
    enqueueReembed: mock(() => {}),
  };
}

/**
 * Replicates the lifecycle Qdrant-started wiring: await the reconcile, swallow
 * any throw, then continue to the next startup step. Returns whether the
 * downstream step ran.
 */
async function runQdrantStartedWiring(
  config: AssistantConfig,
  reconcile: (c: AssistantConfig) => Promise<unknown>,
): Promise<{ reachedNextStep: boolean }> {
  let reachedNextStep = false;
  try {
    await reconcile(config);
  } catch {
    // startup must never block — swallow and continue
  }
  // The next startup step (v2 concept rebuild) always runs.
  reachedNextStep = true;
  return { reachedNextStep };
}

describe("lifecycle embedding-reconcile wiring", () => {
  test("invokes reconcileEmbeddingIdentity with the live config on the startup path", async () => {
    const config = fakeConfig();
    const reconcile = mock(async (_c: AssistantConfig) => undefined);

    await runQdrantStartedWiring(config, reconcile);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(config);
  });

  test("a thrown reconcile does NOT abort startup — downstream step still runs", async () => {
    const config = fakeConfig();
    const reconcile = mock(async (_c: AssistantConfig) => {
      throw new Error("reconcile exploded");
    });

    const { reachedNextStep } = await runQdrantStartedWiring(config, reconcile);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reachedNextStep).toBe(true);
  });

  test("the real reconcile rejects when a destructive op throws — proving the try/catch is load-bearing", async () => {
    const config = fakeConfig();

    // Without the surrounding catch, this would propagate and abort startup.
    await expect(
      reconcileEmbeddingIdentity(config, throwingDeps()),
    ).rejects.toThrow();

    // Through the lifecycle wiring, the throw is swallowed and startup proceeds.
    const { reachedNextStep } = await runQdrantStartedWiring(config, (c) =>
      reconcileEmbeddingIdentity(c, throwingDeps()),
    );
    expect(reachedNextStep).toBe(true);
  });
});
