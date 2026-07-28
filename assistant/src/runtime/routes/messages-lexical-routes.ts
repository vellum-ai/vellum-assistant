/**
 * Messages lexical-index route — enqueues the resumable backfill that indexes
 * existing messages into the Qdrant lexical collection.
 *
 * Deliberately NOT gated on `memory.v2.enabled`: the lexical index powers
 * regular message-content search and is independent of the v2 concept-page
 * machinery. The backfill runs off the event loop as a cursor-checkpointed
 * background job. This route enqueues it on demand (operator or client); the
 * one-time, checkpoint-guarded startup auto-enqueue
 * (`maybeEnqueueLexicalBackfillOnUpgrade`) enqueues the same job once per
 * instance on upgrade.
 */

import { z } from "zod";

import { clearLexicalBackfillComplete } from "../../persistence/checkpoints.js";
import {
  enqueueMemoryJob,
  type MemoryJobType,
} from "../../persistence/jobs-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const BACKFILL_LEXICAL_INDEX_JOB: MemoryJobType = "backfill_lexical_index";

const MessagesLexicalBackfillParams = z
  .object({
    /**
     * Reset the cursor and re-index every message from the beginning. Omit (or
     * pass false) to resume from the last checkpoint — the common case for
     * continuing an interrupted backfill.
     */
    force: z.boolean().optional(),
  })
  .strict();

export type MessagesLexicalBackfillResult = {
  jobId: string;
};

async function handleBackfillLexicalIndex({
  body = {},
}: RouteHandlerArgs): Promise<MessagesLexicalBackfillResult> {
  const { force } = MessagesLexicalBackfillParams.parse(body);
  if (force === true) {
    // Clear the completion sentinel at enqueue time so `isLexicalBackfillComplete()`
    // flips false immediately — the read paths fall back to SQLite FTS in the window
    // between enqueue and the worker claiming the job, instead of serving from the
    // stale/emptying `messages_lexical` collection the forced rebuild is about to
    // reset. The handler clears it again when it runs (idempotent).
    clearLexicalBackfillComplete();
  }
  const payload: Record<string, unknown> =
    force === true ? { force: true } : {};
  const jobId = enqueueMemoryJob(BACKFILL_LEXICAL_INDEX_JOB, payload);
  return { jobId };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "messages_lexical_backfill",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "messages/lexical/backfill",
    handler: handleBackfillLexicalIndex,
    summary: "Enqueue a resumable backfill of messages into the lexical index",
    description:
      "Enqueues the cursor-checkpointed backfill job that indexes existing messages into the Qdrant lexical (BM25-style) collection in batches. Resumable and idempotent — re-running continues from the last checkpoint. Pass `force: true` to reset the cursor and re-index from the beginning. The same backfill is also auto-enqueued once per instance on upgrade at assistant startup.",
    tags: ["memory"],
    requestBody: MessagesLexicalBackfillParams,
  },
];
