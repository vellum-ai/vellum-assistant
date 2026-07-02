/**
 * Static manifest of the daemon's non-plugin ("domain") background-job handlers.
 *
 * These handlers belong to host domains — persistence cleanup, lexical
 * indexing, conversations, media, home, runtime — not to any plugin, so the
 * worker imports them directly. The worker seeds its dispatch table from this
 * manifest at module load, so no imperative registration call from daemon
 * startup or a plugin hook is needed (plugin-contributed handlers flow through
 * the plugin registry instead — see `plugins/job-handler-registry.ts`).
 *
 * Each handler is a thin arrow that reads the imported binding at dispatch time
 * rather than capturing it eagerly, so a per-test `mock.module` of the
 * underlying handler is honored.
 */

import { buildConversationSummaryJob } from "../../conversations/job-handlers/summarization.js";
import { generateConversationStartersJob } from "../../home/job-handlers/conversation-starters.js";
import { mediaProcessingJob } from "../../media/job-handlers/media-processing.js";
import { conversationAnalyzeJob } from "../../runtime/services/conversation-analyze-job.js";
import type { JobHandler } from "../jobs-store.js";
import {
  pruneOldConversationsJob,
  pruneOldLlmRequestLogsJob,
  pruneOldToolInvocationsJob,
  pruneOldTraceEventsJob,
} from "./cleanup.js";
import {
  deleteMessageLexicalJob,
  indexMessageLexicalJob,
  purgeConversationLexicalJob,
} from "./message-lexical.js";
import { backfillLexicalIndexJob } from "./message-lexical-backfill.js";

/** Daemon-owned job handlers, keyed by job type. */
export const DOMAIN_JOB_HANDLERS: Readonly<Record<string, JobHandler>> = {
  prune_old_conversations: (job, config) =>
    pruneOldConversationsJob(job, config),
  // Message-content lexical indexing powers regular message search — host
  // infrastructure, not a memory-plugin feature (the jobs merely share the
  // background job queue).
  index_message_lexical: (job, config) => indexMessageLexicalJob(job, config),
  purge_conversation_lexical: (job, config) =>
    purgeConversationLexicalJob(job, config),
  delete_message_lexical: (job, config) => deleteMessageLexicalJob(job, config),
  backfill_lexical_index: (job, config) => backfillLexicalIndexJob(job, config),
  prune_old_llm_request_logs: (job, config) =>
    pruneOldLlmRequestLogsJob(job, config),
  prune_old_trace_events: (job, config) => pruneOldTraceEventsJob(job, config),
  prune_old_tool_invocations: (job, config) =>
    pruneOldToolInvocationsJob(job, config),
  build_conversation_summary: async (job, config) => {
    // Stale rows enqueued before v2 was enabled must not consume the
    // `conversationSummarization` LLM budget — v2 readers do not consume
    // `memorySummaries`, mirroring the `graph_extract` gate in the memory
    // plugin's job handlers.
    if (config.memory.v2.enabled) {
      return;
    }
    await buildConversationSummaryJob(job, config);
  },
  media_processing: (job) => mediaProcessingJob(job),
  conversation_analyze: (job, config) => conversationAnalyzeJob(job, config),
  generate_conversation_starters: (job) => generateConversationStartersJob(job),
};
