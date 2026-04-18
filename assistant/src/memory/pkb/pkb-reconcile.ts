/**
 * PKB (Personal Knowledge Base) startup reconciliation.
 *
 * Diffs the on-disk PKB tree against the points currently indexed in Qdrant
 * and brings the two into alignment by enqueueing re-index jobs for
 * changed/new files and deleting Qdrant points for files that no longer
 * exist on disk.
 *
 * Safe to run on every daemon boot — idempotent. Intended to be invoked
 * fire-and-forget from daemon startup so the filesystem view stays
 * authoritative without blocking the first turn on scan latency.
 */

import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { enqueuePkbIndexJob } from "../jobs/embed-pkb-file.js";
import { getQdrantClient } from "../qdrant-client.js";
import { deletePkbFilePoints, scanPkbFiles } from "./pkb-index.js";
import { PKB_TARGET_TYPE } from "./types.js";

const log = getLogger("pkb-reconcile");

export interface ReconcilePkbIndexResult {
  enqueued: number;
  deleted: number;
}

/**
 * Reconcile the PKB Qdrant index against the on-disk tree at `pkbRoot`.
 *
 * For each on-disk file whose `contentHash` differs from the indexed hash
 * (or that is missing from the index entirely) enqueue a re-index job. For
 * each indexed path no longer present on disk, delete its Qdrant points.
 *
 * Returns the number of jobs enqueued and the number of paths deleted.
 */
export async function reconcilePkbIndex(
  pkbRoot: string,
  memoryScopeId: string,
): Promise<ReconcilePkbIndexResult> {
  // Build the on-disk view keyed by relative path. `scanPkbFiles` emits one
  // entry per chunk — every chunk of the same file shares the same
  // contentHash, so collapsing to a per-path map is lossless for our purposes.
  const diskEntries = await scanPkbFiles(pkbRoot);
  const diskByPath = new Map<string, { contentHash: string }>();
  for (const entry of diskEntries) {
    if (!diskByPath.has(entry.path)) {
      diskByPath.set(entry.path, { contentHash: entry.contentHash });
    }
  }

  // Build the indexed view keyed by relative path. Qdrant stores one point
  // per (path, chunk_index), so multiple scroll results can share the same
  // path; we only need the content_hash, which is identical across chunks.
  const qdrant = getQdrantClient();
  const points = await qdrant.scrollByTargetType(PKB_TARGET_TYPE, {
    memoryScopeId,
  });
  const indexedByPath = new Map<string, { contentHash: string }>();
  for (const { payload } of points) {
    const path = typeof payload.path === "string" ? payload.path : undefined;
    const contentHash =
      typeof payload.content_hash === "string"
        ? payload.content_hash
        : undefined;
    if (!path || !contentHash) continue;
    if (!indexedByPath.has(path)) {
      indexedByPath.set(path, { contentHash });
    }
  }

  let enqueued = 0;
  let deleted = 0;

  // Re-index files that are new or have changed on disk.
  for (const [relPath, disk] of diskByPath) {
    const indexed = indexedByPath.get(relPath);
    if (!indexed || indexed.contentHash !== disk.contentHash) {
      enqueuePkbIndexJob({
        pkbRoot,
        absPath: join(pkbRoot, relPath),
        memoryScopeId,
      });
      enqueued++;
    }
  }

  // Remove indexed paths that no longer exist on disk.
  for (const relPath of indexedByPath.keys()) {
    if (!diskByPath.has(relPath)) {
      try {
        await deletePkbFilePoints(relPath);
        deleted++;
      } catch (err) {
        log.warn(
          { err, relPath },
          "Failed to delete stale PKB points — continuing reconciliation",
        );
      }
    }
  }

  if (enqueued > 0 || deleted > 0) {
    log.info(
      {
        pkbRoot,
        memoryScopeId,
        enqueued,
        deleted,
        diskCount: diskByPath.size,
        indexedCount: indexedByPath.size,
      },
      "PKB index reconciled against filesystem",
    );
  }

  return { enqueued, deleted };
}
