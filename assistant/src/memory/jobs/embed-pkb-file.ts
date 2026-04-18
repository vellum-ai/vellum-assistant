import type { AssistantConfig } from "../../config/types.js";
import { asString } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { indexPkbFile } from "../pkb/pkb-index.js";

/**
 * Input shape for the `embed_pkb_file` background job.
 */
export interface EmbedPkbFileJobInput {
  pkbRoot: string;
  absPath: string;
  memoryScopeId: string;
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
  const memoryScopeId = asString(job.payload.memoryScopeId);
  if (!pkbRoot || !absPath || !memoryScopeId) return;

  await indexPkbFile(pkbRoot, absPath, memoryScopeId);
}

/**
 * Enqueue an `embed_pkb_file` job (async, fire-and-forget).
 */
export function enqueuePkbIndexJob(input: EmbedPkbFileJobInput): string {
  return enqueueMemoryJob("embed_pkb_file", {
    pkbRoot: input.pkbRoot,
    absPath: input.absPath,
    memoryScopeId: input.memoryScopeId,
  });
}
