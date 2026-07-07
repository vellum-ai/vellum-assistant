/**
 * Default `memory` conversation-deleted hook.
 *
 * Fails the plugin's own still-pending background jobs referencing the
 * deleted conversation (graph extraction, embeddings, sweeps, …) so the
 * worker does not burn cycles — and error noise — on jobs whose conversation
 * no longer exists.
 *
 * The sweep is scoped to the plugin's own job types (derived from its handler
 * table). The dispatch is fire-and-forget, so the sweep runs concurrently
 * with the host cleanup jobs the delete primitive enqueues (e.g. the lexical
 * purge) — scoping by type is what keeps those host jobs out of its blast
 * radius without needing any ordering between them.
 */

import type {
  ConversationDeletedContext,
  HookFunction,
} from "@vellumai/plugin-api";

import { memoryJobHandlers } from "../job-handlers.js";
import { cancelPendingJobsForConversation } from "../task-memory-cleanup.js";

const MEMORY_JOB_TYPES: readonly string[] = memoryJobHandlers.map(
  (entry) => entry.type,
);

const conversationDeleted: HookFunction<ConversationDeletedContext> = async (
  ctx,
) => {
  cancelPendingJobsForConversation(ctx.conversationId, MEMORY_JOB_TYPES);
};

export default conversationDeleted;
