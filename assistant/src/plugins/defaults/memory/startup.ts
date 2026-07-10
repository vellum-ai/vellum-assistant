/**
 * Memory plugin — background startup orchestration.
 *
 * Boots the Qdrant vector store, reconciles the embedding-identity and v2
 * concept-page collections, runs the PKB and BM25 reconciles, and seeds the
 * capability graph. Kicked off fire-and-forget from the memory plugin's `init`
 * hook during daemon plugin bootstrap (after the runtime HTTP server is up), so
 * the daemon accepts requests without waiting on Qdrant. Each step contains its
 * own failure so a memory-subsystem problem never blocks boot.
 *
 * Job-handler registration happens in the plugin's `init` hook, synchronously,
 * before this is kicked off — so the memory handlers are guaranteed to be in the
 * dispatch table before the jobs worker started near the end of this function
 * claims its first job.
 */

import { join } from "node:path";

import type { AssistantConfig } from "../../../config/schema.js";
import { reconcileEmbeddingIdentity } from "../../../daemon/embedding-reconcile.js";
import { refreshSkillCapabilityMemories } from "../../../daemon/skill-memory-refresh.js";
import { selectEmbeddingBackend } from "../../../persistence/embeddings/embedding-backend.js";
import {
  initMessagesLexicalIndex,
  MESSAGES_LEXICAL_COLLECTION,
} from "../../../persistence/embeddings/messages-lexical-index.js";
import {
  clearRebuildSentinel,
  initQdrantClient,
} from "../../../persistence/embeddings/qdrant-client.js";
import { createQdrantManager } from "../../../persistence/embeddings/qdrant-manager.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
} from "../../../persistence/jobs-store.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { resolveQdrantUrl } from "./embeddings.js";
import { startMemoryJobsWorker } from "./jobs-worker.js";
import { getLogger } from "./logging.js";
import { sweepConceptPageFrontmatter } from "./v2/frontmatter-sweep.js";
import {
  maybeRebuildMemoryV2Concepts,
  rebuildBm25CorpusStatsAndReseedSkills,
} from "./v2/memory-v2-startup.js";

const log = getLogger("memory-startup");

export async function runMemoryStartup(config: AssistantConfig): Promise<void> {
  const qdrantUrl = resolveQdrantUrl();
  log.info({ qdrantUrl }, "Daemon startup: initializing Qdrant");
  const manager = createQdrantManager({ url: qdrantUrl });
  const QDRANT_START_MAX_ATTEMPTS = 3;
  let qdrantStarted = false;
  for (let attempt = 1; attempt <= QDRANT_START_MAX_ATTEMPTS; attempt++) {
    try {
      await manager.start();
      qdrantStarted = true;
      break;
    } catch (err) {
      if (attempt < QDRANT_START_MAX_ATTEMPTS) {
        const backoffMs = attempt * 5_000; // 5s, 10s
        log.warn(
          {
            err,
            attempt,
            maxAttempts: QDRANT_START_MAX_ATTEMPTS,
            backoffMs,
          },
          "Qdrant startup failed, retrying",
        );
        await Bun.sleep(backoffMs);
      } else {
        log.warn(
          { err },
          "Qdrant failed to start after all attempts — memory features will be unavailable",
        );
      }
    }
  }

  if (qdrantStarted) {
    // Skip the v1 Qdrant collection lifecycle when memory v2 is active —
    // the v1 collection has no writers (handleRemember returns early) or
    // readers (graph search is bypassed) under v2, so ensuring/migrating
    // it just maintains a dead-on-arrival collection. Existing on-disk
    // collections are left intact so flipping v2 off restores v1 cleanly.
    if (!config.memory.v2.enabled) {
      try {
        const embeddingSelection = await selectEmbeddingBackend(config);
        // Sentinel only encodes the dense provider+model identity; sparse
        // encoder changes never require collection recreation, so they
        // intentionally do not contribute to the v1 collection identity.
        const embeddingModel = embeddingSelection.backend
          ? `${embeddingSelection.backend.provider}:${embeddingSelection.backend.model}`
          : undefined;
        const qdrantClient = initQdrantClient({
          url: qdrantUrl,
          collection: config.memory.qdrant.collection,
          vectorSize: config.memory.qdrant.vectorSize,
          onDisk: config.memory.qdrant.onDisk,
          quantization: config.memory.qdrant.quantization,
          embeddingModel,
        });

        // Eagerly ensure the collection exists so we detect migrations
        // (unnamed→named vectors, dimension/model changes) at startup.
        // If a destructive migration occurred, enqueue a rebuild_index job
        // to re-embed all memory items from the SQLite cache.
        const { migrated } = await qdrantClient.ensureCollection();
        if (migrated && isMemoryEnabled()) {
          enqueueMemoryJob("rebuild_index", {});
          // Clear the on-disk sentinel the ensure-path writes before its
          // destructive delete: now that rebuild_index is queued, the
          // cross-boot signal can retire. No-op if no sentinel was written.
          await clearRebuildSentinel();
          log.info(
            "Qdrant collection was migrated — enqueued rebuild_index job",
          );
        }

        log.info("Qdrant vector store initialized");
      } catch (err) {
        log.warn(
          { err },
          "Qdrant client initialization failed — memory features will be degraded",
        );
      }
    }

    // Initialize the messages lexical index — a dedicated sparse-only Qdrant
    // collection that is the lexical (BM25-style) replacement for SQLite FTS5
    // over message content. Independent of the v1 dense collection lifecycle
    // (sparse-only, no embedding model), so it is constructed whenever Qdrant
    // is up regardless of the v2 flag. Lazy collection creation lives in the
    // client, so this only wires the singleton.
    try {
      initMessagesLexicalIndex({
        url: qdrantUrl,
        collection: MESSAGES_LEXICAL_COLLECTION,
        onDisk: config.memory.qdrant.onDisk,
      });
    } catch (err) {
      log.warn(
        { err },
        "Messages lexical index initialization failed — lexical search will be degraded",
      );
    }

    // Reconcile the committed embedding-collection dimension against a live
    // backend probe (confirm-before-destroy) before the v2 rebuild and the
    // worker drain, so `memory.qdrant.vectorSize` is settled first. Its own
    // try/catch keeps an unreachable backend or reconcile failure from
    // blocking startup.
    try {
      await reconcileEmbeddingIdentity(config);
    } catch (err) {
      log.warn(
        { err },
        "Embedding-identity reconcile threw — continuing startup",
      );
    }

    // Detect schema drift on the v2 concept-page collection (e.g.
    // pre-#29823 collections lacking summary_dense / summary_sparse) and
    // recreate + enqueue a reembed when needed. Awaited inline so the
    // reembed enqueue happens before the memory worker drains its first
    // batch; the call's own try/catch keeps any v2-side failure from
    // blocking the v1 PKB reconcile or BM25 build below.
    try {
      await maybeRebuildMemoryV2Concepts(config);
    } catch (err) {
      log.warn(
        { err },
        "Memory v2 collection schema check threw — continuing startup",
      );
    }

    // Reconcile the PKB Qdrant index against the on-disk tree. Gated on
    // !v2 because PKB is the v1 storage layer; under v2 the v1 collection
    // is not initialized, so calling `getQdrantClient()` here would throw.
    // Fire-and-forget so enqueued re-index jobs drain in the background
    // and first-turn latency stays unaffected.
    if (!config.memory.v2.enabled) {
      void (async () => {
        try {
          const { reconcilePkbIndex } = await import("./pkb/pkb-reconcile.js");
          const pkbRoot = join(getWorkspaceDir(), "pkb");
          await reconcilePkbIndex(pkbRoot);
        } catch (err) {
          log.warn(
            { err },
            "PKB index reconciliation failed — continuing startup",
          );
        }
      })();
    }

    void rebuildBm25CorpusStatsAndReseedSkills(config);

    try {
      await sweepConceptPageFrontmatter(config, getWorkspaceDir());
    } catch (err) {
      log.warn(
        { err },
        "Concept page frontmatter sweep threw — continuing startup",
      );
    }
  }

  // `startMemoryJobsWorker` starts the in-process supervisor (which owns the
  // synchronous runner and stands down when an out-of-process worker is live)
  // and spawns the out-of-process worker at boot when `memory.worker.enabled`
  // is set. Shutdown stops whichever worker is actually running — see
  // shutdown-handlers.ts. The job handlers were registered synchronously by the
  // plugin's `init` hook before this function was kicked off, so the dispatch
  // table is populated before the worker's first claim.
  log.info("Daemon startup: starting memory worker");
  startMemoryJobsWorker();

  // Seed capability graph nodes (new memory graph system)
  try {
    const { seedCliGraphNodes } = await import("./graph/capability-seed.js");
    refreshSkillCapabilityMemories(config);
    await seedCliGraphNodes();
  } catch (err) {
    log.warn({ err }, "Graph capability seeding failed — continuing");
  }

  // Auto-bootstrap: if the graph has no non-procedural nodes but historical
  // segments exist, enqueue a one-time graph_bootstrap job to populate the
  // graph from conversation history and journal files.
  try {
    const { maybeEnqueueGraphBootstrap, cleanupStaleItemVectors } =
      await import("./graph/bootstrap.js");
    maybeEnqueueGraphBootstrap();
    // Fire-and-forget: clean up orphaned Qdrant vectors from dropped memory_items table
    void cleanupStaleItemVectors().catch((err) =>
      log.warn({ err }, "Stale item vector cleanup failed — continuing"),
    );
  } catch (err) {
    log.warn({ err }, "Graph bootstrap check failed — continuing");
  }
}
