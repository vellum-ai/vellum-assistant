// ---------------------------------------------------------------------------
// V1 — delete with v1
//
// Memory Graph — v1 embedding reconcile for graph nodes.
//
// `memory_graph_nodes` is written on EVERY tier: the memory-item routes create
// and edit nodes, the `memory_edit` tool rewrites them, the playbook and
// messaging-style skills upsert them, and capability seeding upserts its own.
// Each of those write paths enqueues `embed_graph_node` — but the embedding
// itself is v1-only, so `processJob` completes those rows as no-ops while the
// concept-page substrate (or memory-off) is live. Nothing re-enqueues them on a
// later return to v1, which is how a node written under the substrate ends up
// permanently missing from — or stale in — v1 semantic retrieval.
//
// WHY RECONCILE ON ENTRY RATHER THAN POSTPONE THE JOB. The worker already has a
// postpone mechanism (`SweepPostponedOffV1Error`), but its semantics are the
// opposite of what these rows need: it exists for a ONE-SHOT cleanup with no
// re-enqueue, and it keeps a single row pending forever on an assistant that
// never returns to v1. `embed_graph_node` is high-volume and open-ended — every
// user edit adds a row — so postponing turns an assistant that stays on v2/v3
// into one carrying an unbounded pending backlog that the queue re-claims on a
// 6h cadence and never drains. Reconciling on entry leaves no pending rows,
// matches the design already in place for capability nodes, and pays its cost
// exactly once per stay on the tier. Its cost is a scan, so the scan is
// keyset-paginated in bounded batches that yield to the event loop between
// them, and it runs detached from the worker tick.
// ---------------------------------------------------------------------------

import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";

import { getConfig } from "../../../../config/loader.js";
import { isMemoryV1Active } from "../../../../config/memory-v3-gate.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { getMemoryBackendStatus } from "../../../../persistence/embeddings/embedding-backend.js";
import { embeddingInputContentHash } from "../../../../persistence/embeddings/embedding-types.js";
import { upsertEmbedGraphNodeJob } from "../../../../persistence/jobs-store.js";
import {
  memoryEmbeddings,
  memoryGraphNodes,
} from "../../../../persistence/schema/index.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";
import { formatNodeForEmbedding } from "./graph-search.js";
import { rowToNode } from "./store.js";
import type { MemoryNode } from "./types.js";

const log = getLogger("graph-node-embedding-reconcile");

/**
 * Nodes read (and embedding rows looked up) per round of the full-graph scan.
 * One indexed range read plus one indexed `memory_embeddings` lookup per round,
 * with a yield between rounds — small enough that neither query holds the
 * worker process for long, large enough that a big graph does not cost
 * thousands of round trips.
 */
const SCAN_BATCH_SIZE = 200;

/**
 * Runaway guard on the full-graph scan: a pass stops after this many nodes and
 * logs where it stopped. Not a correctness bound — every realistic graph is far
 * smaller, and the next v1 entry starts the scan over — but a v1 entry must
 * never turn into unbounded background work on a pathological database.
 */
const SCAN_MAX_NODES = 50_000;

/** The embedding backend identity `memory_embeddings` rows are keyed by. */
interface BackendIdentity {
  provider: string;
  model: string;
}

/**
 * Enqueue `embed_graph_node` for every node in `nodes` whose current content
 * has no dense embedding under the current embedding backend.
 *
 * A node created or edited while concept-page memory is active gets no embed
 * row, so under v1 the write path's own enqueue is not enough to guarantee a
 * point exists. A node counts as embedded only when a `memory_embeddings` row
 * matches all three facets of its current embedding identity:
 *
 *  - `(target_type, target_id)` — the node itself;
 *  - `(provider, model)` — the table is keyed per backend, so a row written by
 *    a previous backend describes vectors that are not in play any more;
 *  - `content_hash` — of the exact text `embedGraphNodeDirect` embeds for a
 *    node without image refs, so a node whose content changed under a higher
 *    tier re-embeds instead of keeping the vector built from the old text.
 *
 * Rows are written only after the Qdrant upsert succeeds (see `embedAndUpsert`),
 * so a present row also means the point itself landed. The enqueue coalesces
 * with a pending `embed_graph_node` row for the same node, so back-to-back
 * passes queue at most one job per node while the first is still pending.
 *
 * Fail-open and never rejects: an unresolvable backend or a lookup error logs
 * and skips the pass — reconciliation never blocks its caller.
 */
export async function reconcileGraphNodeEmbeddings(
  nodes: readonly MemoryNode[],
): Promise<void> {
  if (nodes.length === 0) {
    return;
  }
  try {
    const identity = await currentBackendIdentity();
    if (!identity) {
      return;
    }
    for (let start = 0; start < nodes.length; start += SCAN_BATCH_SIZE) {
      enqueueMissing(nodes.slice(start, start + SCAN_BATCH_SIZE), identity);
    }
  } catch (err) {
    log.warn({ err }, "Graph-node embedding reconcile failed; skipping");
  }
}

/**
 * Re-enqueue `embed_graph_node` for every live graph node whose current content
 * has no embedding under the current backend — the v1-entry backfill for
 * ordinary user-created and user-edited nodes, which the capability seeders do
 * not cover.
 *
 * Self-gated on {@link isMemoryV1Active} so both call sites (the worker's
 * `maybeRunV1EntryReconcile` and the daemon's v1 boot claim in `startup.ts`)
 * stay a single detached line. Callers fire-and-forget it: the scan yields
 * between batches so it interleaves with the worker's poll loop instead of
 * stalling a tick, and it is idempotent, so a pass cut short by shutdown simply
 * runs again on the next v1 entry.
 *
 * `gone` nodes are excluded — `embedGraphNodeDirect` returns early for them, so
 * an embed job would be a no-op.
 *
 * Fail-open and never rejects.
 */
export async function reconcileAllGraphNodeEmbeddings(): Promise<void> {
  if (!isMemoryV1Active(getConfig())) {
    return;
  }
  try {
    const identity = await currentBackendIdentity();
    if (!identity) {
      return;
    }
    const db = memoryDbOrNull("reconcileAllGraphNodeEmbeddings");
    if (!db) {
      return;
    }

    // Keyset pagination on the primary key: each round reads the next
    // `SCAN_BATCH_SIZE` ids strictly greater than the last one seen, so the
    // scan never rescans a page and never skips one when rows are inserted
    // mid-pass.
    let cursor = "";
    let scanned = 0;
    let enqueued = 0;
    for (;;) {
      const rows = db
        .select()
        .from(memoryGraphNodes)
        .where(
          and(
            gt(memoryGraphNodes.id, cursor),
            ne(memoryGraphNodes.fidelity, "gone"),
          ),
        )
        .orderBy(asc(memoryGraphNodes.id))
        .limit(SCAN_BATCH_SIZE)
        .all();
      if (rows.length === 0) {
        break;
      }
      cursor = rows[rows.length - 1]!.id;
      scanned += rows.length;
      enqueued += enqueueMissing(toNodes(rows), identity);

      if (rows.length < SCAN_BATCH_SIZE) {
        break;
      }
      if (scanned >= SCAN_MAX_NODES) {
        log.warn(
          { scanned, enqueued, cursor },
          "Graph-node embedding reconcile hit its scan cap; stopping this pass",
        );
        break;
      }
      // Hand the loop back so the worker's poll and any in-flight job keep
      // running while a large graph is walked.
      await yieldToEventLoop();
    }

    if (enqueued > 0) {
      log.info(
        { scanned, enqueued },
        "Re-enqueued graph nodes missing a v1 embedding",
      );
    } else {
      log.debug({ scanned }, "Graph-node embeddings already current");
    }
  } catch (err) {
    log.warn({ err }, "Graph-node embedding reconcile scan failed; skipping");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function currentBackendIdentity(): Promise<BackendIdentity | null> {
  const status = await getMemoryBackendStatus(getConfig());
  if (!status.provider || !status.model) {
    return null;
  }
  return { provider: status.provider, model: status.model };
}

/**
 * Project rows to nodes, dropping any whose JSON columns fail to parse. One
 * malformed row must not abort a whole reconcile pass.
 */
function toNodes(
  rows: readonly (typeof memoryGraphNodes.$inferSelect)[],
): MemoryNode[] {
  const nodes: MemoryNode[] = [];
  for (const row of rows) {
    try {
      nodes.push(rowToNode(row));
    } catch (err) {
      log.warn({ err, nodeId: row.id }, "Skipping unparseable graph node row");
    }
  }
  return nodes;
}

/**
 * Enqueue an embed for each node in one batch that lacks a current embedding.
 * One indexed `memory_embeddings` read covers the whole batch (the unique index
 * is on target + provider + model), so the predicate costs a single query
 * regardless of batch size. Returns how many nodes were enqueued.
 */
function enqueueMissing(
  nodes: readonly MemoryNode[],
  identity: BackendIdentity,
): number {
  if (nodes.length === 0) {
    return 0;
  }
  const stored = new Map<string, string | null>();
  const rows = getDb()
    .select({
      targetId: memoryEmbeddings.targetId,
      contentHash: memoryEmbeddings.contentHash,
    })
    .from(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, "graph_node"),
        inArray(
          memoryEmbeddings.targetId,
          nodes.map((node) => node.id),
        ),
        eq(memoryEmbeddings.provider, identity.provider),
        eq(memoryEmbeddings.model, identity.model),
      ),
    )
    .all();
  for (const row of rows) {
    stored.set(row.targetId, row.contentHash);
  }

  let enqueued = 0;
  for (const node of nodes) {
    if (!needsEmbed(node, stored)) {
      continue;
    }
    upsertEmbedGraphNodeJob({ nodeId: node.id });
    enqueued += 1;
  }
  return enqueued;
}

/**
 * Whether a node's current content is missing from the embedding cache.
 *
 * A node carrying image refs always re-enqueues: `embedGraphNodeDirect` embeds
 * the image bytes when the backend is multimodal and a text-plus-descriptions
 * variant otherwise, so the hash the embed job would write is not derivable
 * here without reading the image off disk. Re-enqueuing is the cheap side of
 * that trade — the embed job's own content-hash cache short-circuits the
 * backend call when the vector is already stored, and this runs once per v1
 * entry, not per tick.
 */
function needsEmbed(
  node: MemoryNode,
  stored: ReadonlyMap<string, string | null>,
): boolean {
  if (node.imageRefs && node.imageRefs.length > 0) {
    return true;
  }
  const hash = stored.get(node.id);
  if (typeof hash !== "string") {
    // No row for this backend, or a legacy row that stored no hash.
    return true;
  }
  return hash !== embeddingInputContentHash(formatNodeForEmbedding(node));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
