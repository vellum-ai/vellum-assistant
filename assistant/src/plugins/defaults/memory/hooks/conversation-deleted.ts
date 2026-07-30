/**
 * Default `memory` conversation-deleted hook.
 *
 * Does two independent things for the deleted conversation:
 *
 * 1. Fails the plugin's own still-pending background jobs referencing it
 *    (graph extraction, embeddings, sweeps, …) so the worker does not burn
 *    cycles — and error noise — on jobs whose conversation no longer exists.
 *    The sweep is scoped to the plugin's own job types (derived from its
 *    handler table). The dispatch is fire-and-forget, so the sweep runs
 *    concurrently with the host cleanup jobs the delete primitive enqueues
 *    (e.g. the lexical purge) — scoping by type is what keeps those host jobs
 *    out of its blast radius without needing any ordering between them.
 *
 * 2. Purges the conversation's rows from the per-conversation memory tables on
 *    the dedicated memory connection. SQLite foreign keys cannot span database
 *    files, so the main-DB delete cascade never reaches those relocated tables;
 *    this hook replaces the lost cascade with an explicit best-effort delete.
 *    It touches a disjoint set of tables from the job sweep, so the two do not
 *    interfere.
 */

import type {
  ConversationDeletedContext,
  HookFunction,
} from "@vellumai/plugin-api";

import { purgeConversationMemoryTables } from "../conversation-memory-purge.js";
import { memoryJobHandlers } from "../job-handlers.js";
import { cancelPendingJobsForConversation } from "../task-memory-cleanup.js";

const MEMORY_JOB_TYPES: readonly string[] = memoryJobHandlers.map(
  (entry) => entry.type,
);

const conversationDeleted: HookFunction<ConversationDeletedContext> = async (
  ctx,
) => {
  cancelPendingJobsForConversation(ctx.conversationId, MEMORY_JOB_TYPES);
  purgeConversationMemoryTables(ctx.conversationId);
};

export default conversationDeleted;
