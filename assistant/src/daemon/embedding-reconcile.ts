// ---------------------------------------------------------------------------
// Embedding-identity reconcile orchestrator
// ---------------------------------------------------------------------------
//
// Ties the read primitives (`probeBackendDimension` /
// `readConceptPageCollectionDim`) and the pure decision (`decideEmbeddingReconcile`)
// to the side-effecting collaborators that commit a dimension, recreate the
// Qdrant collections, and enqueue a reembed. The dimension of the embedding
// collections is a derived, committed property reconciled at startup with
// confirm-before-destroy: a destructive collection recreate runs only on a
// `migrate` action, and only after a non-null backend probe.
//
// All collaborators are injectable so the decision/write-gating can be tested
// without Qdrant, a real backend, or config-file I/O.

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../config/loader.js";
import { isMemoryV3Live } from "../config/memory-v3-gate.js";
import type { AssistantConfig } from "../config/types.js";
import {
  ensureConceptPageCollection,
  recreateConceptPageCollection,
} from "../memory/v2/qdrant.js";
import {
  probeBackendDimension,
  readConceptPageCollectionDim,
} from "../persistence/embeddings/embedding-identity.js";
import { decideEmbeddingReconcile } from "../persistence/embeddings/reconcile-decision.js";
import { enqueueMemoryJob } from "../persistence/jobs-store.js";
import {
  ensureSectionCollection,
  recreateSectionCollection,
} from "../plugins/defaults/memory/v3/section-dense-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("embedding-reconcile");

export type ReconcileOutcome =
  | { action: "noop"; dim: number | null }
  | { action: "commit-fresh"; dim: number }
  | { action: "migrate"; fromDim: number; toDim: number }
  | { action: "defer-degraded"; reason: string };

/**
 * Injectable collaborators for {@link reconcileEmbeddingIdentity}. Defaults wire
 * the real read primitives, decision, and side-effecting collaborators; tests
 * override them with spies to exercise each decision branch and assert which
 * destructive/write paths run.
 */
export interface ReconcileDeps {
  probeBackendDimension: typeof probeBackendDimension;
  readConceptPageCollectionDim: typeof readConceptPageCollectionDim;
  decideEmbeddingReconcile: typeof decideEmbeddingReconcile;
  /** Commit the reconciled dimension to `memory.qdrant.vectorSize` on disk. */
  persistVectorSize: (dim: number) => void;
  /** Make the committed dimension visible to same-process config readers. */
  setInMemoryVectorSize: (dim: number) => void;
  /** Destroy + recreate the v2 and v3 collections at `dim` (the only destructive path). */
  recreateCollectionsAtDim: (dim: number) => Promise<void>;
  /** Ensure the v2 + v3 collections exist at the committed dim without destroying. */
  ensureCollections: () => Promise<void>;
  /** Enqueue the reembed jobs that repopulate the (re)created collections. */
  enqueueReembed: () => void;
}

/**
 * Write ONLY `memory.qdrant.vectorSize` into config.json. Deliberately does not
 * touch `provider`, `geminiModel`, or `geminiDimensions` — the committed
 * dimension is derived from the reachable backend's probe, not a provider
 * choice forced into config. Invalidating the cache makes the next
 * `getConfig()` observe the new value, so this doubles as the in-process commit.
 */
function defaultPersistVectorSize(dim: number): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "memory.qdrant.vectorSize", dim);
  saveRawConfig(raw);
  invalidateConfigCache();
}

/**
 * Default `recreateCollectionsAtDim`: destroy + recreate both the v2
 * concept-page collection and the v3 section collection at `dim`. Reuses the
 * recreate helpers each store exports so the named-vector layout and payload
 * indexes flow through the single creation code path. The `dim` is read from
 * config (which the caller has already committed via `persistVectorSize` +
 * cache invalidation) by the underlying `ensure*` calls.
 */
async function defaultRecreateCollectionsAtDim(
  config: AssistantConfig,
): Promise<void> {
  await recreateConceptPageCollection();
  await recreateSectionCollection(config);
}

/**
 * Default `enqueueReembed`: enqueue the v2 reembed, plus the v3 maintain job
 * when v3 is the live injected source for this assistant (its section
 * collection only carries points under v3-live).
 */
function defaultEnqueueReembed(config: AssistantConfig): void {
  enqueueMemoryJob("memory_v2_reembed", {});
  if (isMemoryV3Live(config)) {
    enqueueMemoryJob("memory_v3_maintain", {});
  }
}

function defaultDeps(config: AssistantConfig): ReconcileDeps {
  return {
    probeBackendDimension,
    readConceptPageCollectionDim,
    decideEmbeddingReconcile,
    persistVectorSize: defaultPersistVectorSize,
    // The committed dimension becomes visible to same-process readers through
    // the cache invalidation in `persistVectorSize`; the in-memory commit is an
    // alias of that write rather than a separate mutation.
    setInMemoryVectorSize: () => {},
    recreateCollectionsAtDim: () => defaultRecreateCollectionsAtDim(config),
    ensureCollections: async () => {
      await ensureConceptPageCollection();
      await ensureSectionCollection(config);
    },
    enqueueReembed: () => defaultEnqueueReembed(config),
  };
}

/**
 * Reconcile the committed Qdrant collection dimension against a live probe of
 * the configured embedding backend, then execute the resulting action:
 *
 *  - `noop` — committed dimension already matches (or auto-mode declines to
 *    thrash); no writes, no destructive calls.
 *  - `commit-fresh` — fresh install adopts the reachable backend's dimension:
 *    commit the dim, ensure the collections EXIST at it (create-if-absent, never
 *    destroy), and enqueue a reembed.
 *  - `migrate` — deliberate provider intent with a confirmed probe: commit the
 *    new dim, then destroy + recreate the collections (the only destructive
 *    path) and enqueue a reembed.
 *  - `defer-degraded` — backend unreachable: no write, no destructive call;
 *    warn and leave the collections untouched.
 */
export async function reconcileEmbeddingIdentity(
  config: AssistantConfig,
  deps: ReconcileDeps = defaultDeps(config),
): Promise<ReconcileOutcome> {
  const [committedDim, probe] = await Promise.all([
    deps.readConceptPageCollectionDim(config),
    deps.probeBackendDimension(config),
  ]);

  const action = deps.decideEmbeddingReconcile({
    committedDim,
    probeDim: probe?.dim ?? null,
    configuredProvider: config.memory.embeddings.provider,
  });

  switch (action.kind) {
    case "noop":
      return { action: "noop", dim: committedDim };

    case "commit-fresh": {
      deps.setInMemoryVectorSize(action.dim);
      deps.persistVectorSize(action.dim);
      await deps.ensureCollections();
      deps.enqueueReembed();
      log.info(
        { dim: action.dim },
        "Committed fresh embedding dimension and ensured collections",
      );
      return { action: "commit-fresh", dim: action.dim };
    }

    case "migrate": {
      deps.setInMemoryVectorSize(action.toDim);
      deps.persistVectorSize(action.toDim);
      await deps.recreateCollectionsAtDim(action.toDim);
      deps.enqueueReembed();
      log.warn(
        { fromDim: action.fromDim, toDim: action.toDim },
        "Migrated embedding dimension: recreated collections and enqueued reembed",
      );
      return {
        action: "migrate",
        fromDim: action.fromDim,
        toDim: action.toDim,
      };
    }

    case "defer-degraded":
      log.warn(
        { reason: action.reason },
        "Deferring embedding-identity reconcile; backend unavailable — no destructive action taken",
      );
      return { action: "defer-degraded", reason: action.reason };
  }
}
