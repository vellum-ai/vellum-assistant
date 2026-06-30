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
  probeBackendDimension,
  readConceptPageCollectionDim,
} from "../persistence/embeddings/embedding-identity.js";
import { decideEmbeddingReconcile } from "../persistence/embeddings/reconcile-decision.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
} from "../persistence/jobs-store.js";
import {
  ensureConceptPageCollection,
  recreateConceptPageCollection,
} from "../plugins/defaults/memory/v2/qdrant.js";
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
  ensureCollections: (dim: number) => Promise<void>;
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
 * Shallow-clone `config` with `memory.qdrant.vectorSize` overridden to `dim`.
 *
 * The v2 concept-page recreate reads the freshly-persisted dimension via its own
 * `getConfig()` (the reconcile calls `persistVectorSize` + cache invalidation
 * first), but the v3 section-store collaborators size their collection from the
 * `config` argument passed in — which is the PRE-persist snapshot the reconcile
 * was invoked with. Handing them that snapshot would build `memory_v3_sections`
 * at the OLD dimension while the queued maintain embeds at the new one, so the
 * v3 collaborators are given a config carrying the reconciled `dim`.
 */
function configWithVectorSize(
  config: AssistantConfig,
  dim: number,
): AssistantConfig {
  return {
    ...config,
    memory: {
      ...config.memory,
      qdrant: { ...config.memory.qdrant, vectorSize: dim },
    },
  };
}

/**
 * Default `recreateCollectionsAtDim`: destroy + recreate the v2 concept-page
 * collection at `dim`, plus the v3 section collection when v3 is the live
 * injected source. Reuses the recreate helpers each store exports so the
 * named-vector layout and payload indexes flow through the single creation code
 * path. The v2 recreate reads the committed dim from config (already persisted
 * by the caller); the v3 recreate is handed a config carrying `dim` directly
 * (see {@link configWithVectorSize}). The v3 section collection's lifecycle is
 * gated on `isMemoryV3Live` to match its population gate — a v2-only install
 * never populates it, so it must not be created.
 */
async function defaultRecreateCollectionsAtDim(
  config: AssistantConfig,
  dim: number,
): Promise<void> {
  // Recreate v2 first. A failure here means v2 was NOT rebuilt at the new
  // dimension, so the caller's rollback (restoring the old committed dimension)
  // is correct — config still matches the old/absent v2 collection and the next
  // reconcile re-migrates cleanly.
  await recreateConceptPageCollection();

  // v2 is now rebuilt at `dim`. A v3 recreate failure must NOT propagate: the
  // caller would then roll the committed dimension back below the already-
  // rebuilt v2, desyncing config from v2 and wedging the next reconcile into a
  // no-op (it reads v2's new dimension as committed). The v3 section collection
  // is page-derived and self-heals — its lazy ensure recreates on dimension
  // drift and the enqueued maintain repopulates it — so log and continue,
  // keeping the committed dimension at the rebuilt v2 size.
  if (isMemoryV3Live(config)) {
    try {
      await recreateSectionCollection(configWithVectorSize(config, dim));
    } catch (err) {
      log.warn(
        { err, dim },
        "v3 section collection recreate failed after v2 rebuilt; deferring to its lazy recreate + maintain",
      );
    }
  }
}

/**
 * Default `enqueueReembed`: enqueue the v2 reembed, plus the v3 maintain job
 * when v3 is the live injected source for this assistant (its section
 * collection only carries points under v3-live).
 *
 * Both enqueues dedup against an already-in-flight (pending or running) job of
 * the same type. `memory_v2_reembed` can be enqueued from two startup sites that
 * both guard on this in-flight check: the credential-arrival reconcile retry
 * (reconcile-vs-reconcile), and the lifecycle reconcile-then-rebuild interleaving
 * where `maybeRebuildMemoryV2Concepts` also enqueues a reembed when it finds the
 * just-(re)created collection empty. The guard keeps the corpus re-embed to a
 * single round-trip across either path.
 */
function defaultEnqueueReembed(config: AssistantConfig): void {
  if (!hasActiveJobOfType("memory_v2_reembed")) {
    enqueueMemoryJob("memory_v2_reembed", {});
  }
  if (isMemoryV3Live(config) && !hasActiveJobOfType("memory_v3_maintain")) {
    enqueueMemoryJob("memory_v3_maintain", {});
  }
}

/**
 * Build the production collaborator set: real read primitives + decision wired
 * to the side-effecting defaults (config write, collection ensure/recreate,
 * reembed enqueue). Exported so tests can take the real side-effecting deps and
 * override only the read primitives + decision to drive a specific branch.
 */
export function defaultDeps(config: AssistantConfig): ReconcileDeps {
  return {
    probeBackendDimension,
    readConceptPageCollectionDim,
    decideEmbeddingReconcile,
    persistVectorSize: defaultPersistVectorSize,
    // The committed dimension becomes visible to same-process readers through
    // the cache invalidation in `persistVectorSize`; the in-memory commit is an
    // alias of that write rather than a separate mutation.
    setInMemoryVectorSize: () => {},
    recreateCollectionsAtDim: (dim) =>
      defaultRecreateCollectionsAtDim(config, dim),
    ensureCollections: async (dim) => {
      await ensureConceptPageCollection();
      // The v3 section collection's lifecycle matches its population gate: a
      // v2-only install never writes to it, so it must not be created.
      if (isMemoryV3Live(config)) {
        await ensureSectionCollection(configWithVectorSize(config, dim));
      }
    },
    enqueueReembed: () => defaultEnqueueReembed(config),
  };
}

/**
 * Reconcile the committed Qdrant collection dimension against a live probe of
 * the configured embedding backend, then execute the resulting action:
 *
 *  - `noop` — committed dimension already matches (or auto-mode declines to
 *    thrash); no writes, no destructive calls. Also returned immediately when
 *    `memory.enabled === false`, before any probe/read/persist/enqueue.
 *  - `commit-fresh` — fresh install adopts the reachable backend's dimension:
 *    commit the dim, ensure the collections EXIST at it (create-if-absent, never
 *    destroy), and enqueue a reembed.
 *  - `migrate` — deliberate provider intent with a confirmed probe: commit the
 *    new dim, then destroy + recreate the collections (the only destructive
 *    path) and enqueue a reembed.
 *  - `defer-degraded` — backend unreachable, OR the committed dimension could
 *    not be read (Qdrant unreachable / existing collection unreadable): no
 *    write, no destructive call; warn and leave the collections untouched.
 */
export async function reconcileEmbeddingIdentity(
  config: AssistantConfig,
  deps: ReconcileDeps = defaultDeps(config),
): Promise<ReconcileOutcome> {
  // Memory disabled: the user has opted out, so incur none of the reconcile's
  // cost — no probe (a provider embed call), no committed-dim read, no
  // persist/recreate/enqueue. `memory.enabled` defaults to true; gate strictly
  // on the explicit `false`. This gate covers both the lifecycle startup call
  // and the credential-arrival retry call.
  if (config.memory.enabled === false) {
    log.info("Memory disabled — skipping embedding-identity reconcile");
    return { action: "noop", dim: null };
  }

  // v2 disabled: the reconcile manages the v2 concept-page collection (its
  // committed-dim probe reads `memory_v2_concept_pages`) and the v3 section
  // collection that layers on the v2 page index. A v2-disabled install instead
  // uses the v1 collection, whose dimension is owned by the v1 startup path
  // (`qdrantClient.ensureCollection()` + `rebuild_index` + the lazy v1
  // dimension recreate). Running here would enqueue `memory_v2_reembed` against
  // the disabled v2 index and persist a `vectorSize` after the v1 client was
  // already initialized at the old dimension. Defaults to true; gate strictly
  // on the explicit `false` (and tolerate a missing `v2` node in test configs).
  if (config.memory.v2?.enabled === false) {
    log.info(
      "Memory v2 disabled — skipping embedding-identity reconcile; v1 path owns its collection dimension",
    );
    return { action: "noop", dim: null };
  }

  // Read the committed dimension first, isolated in its own try/catch. A thrown
  // error means Qdrant was unreachable or the existing collection's dimension
  // was unreadable — distinct from a confirmed-absent collection (which returns
  // `null`). Treating "unreadable" as a fresh install would commit the probed
  // dimension while the old collection still exists at the old size, so we
  // defer (degraded) WITHOUT probing, persisting, recreating, or enqueuing.
  // Reading before probing (rather than in a single `Promise.all`) keeps the
  // throw from discarding a successful probe; this is startup, not latency-
  // critical.
  let committedDim: number | null;
  try {
    committedDim = await deps.readConceptPageCollectionDim(config);
  } catch (err) {
    log.warn(
      { err },
      "Could not read committed embedding-collection dimension — deferring reconcile; no destructive action taken",
    );
    return {
      action: "defer-degraded",
      reason: "could not read committed collection dimension",
    };
  }

  const probe = await deps.probeBackendDimension(config);

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
      await deps.ensureCollections(action.dim);
      deps.enqueueReembed();
      log.info(
        { dim: action.dim },
        "Committed fresh embedding dimension and ensured collections",
      );
      return { action: "commit-fresh", dim: action.dim };
    }

    case "migrate": {
      // The committed dimension must be persisted before the recreate so the
      // v2/v3 collection helpers build at the new size. If the destructive
      // recreate then throws (e.g. a transient Qdrant delete/create failure),
      // roll the committed dimension back so config keeps matching the
      // still-existing old collection — otherwise config would advertise the
      // new dimension while the collection stays old, and the availability
      // check would admit new-dimension queries that Qdrant rejects until the
      // next restart. Rolling back leaves a consistent state the next reconcile
      // re-migrates cleanly. The reembed is enqueued only after a successful
      // recreate so it never runs against a collection that was not rebuilt.
      deps.setInMemoryVectorSize(action.toDim);
      deps.persistVectorSize(action.toDim);
      try {
        await deps.recreateCollectionsAtDim(action.toDim);
      } catch (err) {
        deps.setInMemoryVectorSize(action.fromDim);
        deps.persistVectorSize(action.fromDim);
        log.warn(
          { err, fromDim: action.fromDim, toDim: action.toDim },
          "Embedding dimension migration failed during collection recreate; rolled back committed dimension — next reconcile retries",
        );
        throw err;
      }
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
