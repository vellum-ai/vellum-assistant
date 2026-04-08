// ---------------------------------------------------------------------------
// Memory Graph — Extraction job handler
//
// Wraps runGraphExtraction for the jobs worker. Handles both:
// - Mid-conversation batch extraction (incremental, from checkpoint)
// - End-of-conversation extraction (full transcript)
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "../checkpoints.js";
import { maybeEnqueueConversationStartersJob } from "../conversation-starters-cadence.js";
import { asString } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { runGraphExtraction } from "./extraction.js";

const log = getLogger("graph-extraction-job");

/**
 * Job handler for `graph_extract`. Runs incremental or full extraction
 * depending on whether a checkpoint exists for this conversation.
 *
 * Checkpoint key: `graph_extract:<conversationId>:last_ts`
 * Value: epoch ms of the most recent message processed.
 *
 * Trigger sources:
 * - Indexer after batchSize messages (default 10)
 * - Indexer idle debounce (default 300s)
 * - Conversation dispose (end of conversation)
 */
export async function graphExtractJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  const scopeId = asString(job.payload.scopeId) || "default";
  if (!conversationId) return;

  // Read checkpoint for incremental extraction
  const checkpointKey = `graph_extract:${conversationId}:last_ts`;
  const lastTs = getMemoryCheckpoint(checkpointKey);
  const afterTimestamp = lastTs ? parseInt(lastTs, 10) : undefined;

  const activeContextNodeIds = Array.isArray(job.payload.activeContextNodeIds)
    ? (job.payload.activeContextNodeIds as string[])
    : undefined;

  try {
    const result = await runGraphExtraction(conversationId, scopeId, config, {
      afterTimestamp,
      activeContextNodeIds,
    });

    // Update checkpoint to the newest message actually processed — using
    // Date.now() could skip messages that arrived during extraction.
    if (result.lastProcessedTimestamp) {
      setMemoryCheckpoint(checkpointKey, String(result.lastProcessedTimestamp));
    }

    log.info(
      {
        conversationId,
        incremental: !!afterTimestamp,
        ...result,
      },
      "Graph extraction job complete",
    );

    try {
      maybeEnqueueConversationStartersJob(scopeId);
    } catch (cadenceErr) {
      log.warn(
        {
          err:
            cadenceErr instanceof Error
              ? cadenceErr.message
              : String(cadenceErr),
        },
        "Conversation starters cadence check failed (non-fatal)",
      );
    }
  } catch (err) {
    log.error(
      { conversationId, err: err instanceof Error ? err.message : String(err) },
      "Graph extraction job failed",
    );
    throw err;
  }
}
