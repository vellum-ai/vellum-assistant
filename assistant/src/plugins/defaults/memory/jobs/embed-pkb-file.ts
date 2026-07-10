import type { AssistantConfig } from "../../../../config/types.js";
import { asString } from "../../../../persistence/job-utils.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { getMemoryConfig } from "../config.js";
import { indexPkbFile } from "../pkb/pkb-index.js";

/**
 * Input shape for the `embed_pkb_file` background job.
 */
export interface EmbedPkbFileJobInput {
  pkbRoot: string;
  absPath: string;
}

/**
 * Job handler: read a PKB markdown file, chunk it, and upsert each chunk to
 * Qdrant via the shared embedding pipeline. Thin wrapper around
 * {@link indexPkbFile} so write hooks and startup reconciliation can
 * fire-and-forget into the async job queue.
 */
export async function embedPkbFileJob(
  job: MemoryJob,
  _config: AssistantConfig,
): Promise<void> {
  const pkbRoot = asString(job.payload.pkbRoot);
  const absPath = asString(job.payload.absPath);
  if (!pkbRoot || !absPath) return;

  try {
    await indexPkbFile(pkbRoot, absPath);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Enqueue an `embed_pkb_file` job (async, fire-and-forget).
 *
 * PKB is the v1 storage layer; under v2 nothing reads the PKB index and the
 * v1 Qdrant collection is not initialized, so processing the job would throw.
 * Skipping the enqueue here covers every producer (file-write hook, remember,
 * startup reconcile); a later switch back to v1 rebuilds the index via the
 * startup reconcile.
 */
export function enqueuePkbIndexJob(input: EmbedPkbFileJobInput): string {
  if (!isMemoryEnabled()) return "";
  if (getMemoryConfig().v2.enabled) return "";
  return enqueueMemoryJob("embed_pkb_file", {
    pkbRoot: input.pkbRoot,
    absPath: input.absPath,
  });
}
