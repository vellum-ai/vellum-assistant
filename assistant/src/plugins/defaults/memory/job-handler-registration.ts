/**
 * Register the background-job handlers into the worker's dispatch table.
 *
 * The memory plugin owns registration end-to-end: its `init` hook (daemon) and
 * the standalone worker process — the two callers that actually start the
 * worker — register here rather than routing handlers through a generic plugin
 * job-handler registry. Keeping registration inside the plugin means the startup
 * path never has to reach back through the `plugins/defaults` barrel, which would
 * otherwise close an import cycle.
 *
 * This registers the memory plugin's own handlers plus the host's non-plugin
 * domain handlers (persistence cleanup, message-content lexical indexing,
 * conversations, media, home, runtime). Those domain handlers — and their daemon
 * imports below — live here temporarily; they will move to a memory-agnostic
 * background schedule worker in a future rework, at which point they leave the
 * memory plugin.
 *
 * Idempotent: registering a type twice overwrites with the same handler, so
 * repeated calls (e.g. the daemon init hook and the standalone worker process)
 * are safe.
 */

import { buildConversationSummaryJob } from "../../../conversations/job-handlers/summarization.js";
import { generateConversationStartersJob } from "../../../home/job-handlers/conversation-starters.js";
import { mediaProcessingJob } from "../../../media/job-handlers/media-processing.js";
import {
  pruneOldConversationsJob,
  pruneOldLlmRequestLogsJob,
  pruneOldToolInvocationsJob,
  pruneOldTraceEventsJob,
} from "../../../persistence/job-handlers/cleanup.js";
import {
  deleteMessageLexicalJob,
  indexMessageLexicalJob,
  purgeConversationLexicalJob,
} from "../../../persistence/job-handlers/message-lexical.js";
import { backfillLexicalIndexJob } from "../../../persistence/job-handlers/message-lexical-backfill.js";
import { registerJobHandler } from "../../../persistence/jobs-worker.js";
import { conversationAnalyzeJob } from "../../../runtime/services/conversation-analyze-job.js";
import { memoryJobHandlers } from "./job-handlers.js";

export function registerMemoryPluginJobHandlers(): void {
  // The memory plugin's own handlers.
  for (const { type, handler } of memoryJobHandlers) {
    registerJobHandler(type, handler);
  }

  // Non-plugin domain handlers for domains that are not plugins (persistence
  // cleanup, message-content lexical indexing, conversations, media, home,
  // runtime). These are host-owned and merely share the background job queue;
  // they will move to a memory-agnostic background schedule worker soon. Each is
  // registered behind an arrow that reads the imported binding at dispatch time
  // rather than capturing it eagerly, so a per-test `mock.module` of the
  // underlying handler is honored.
  registerJobHandler("prune_old_conversations", (job, config) =>
    pruneOldConversationsJob(job, config),
  );
  registerJobHandler("index_message_lexical", (job, config) =>
    indexMessageLexicalJob(job, config),
  );
  registerJobHandler("purge_conversation_lexical", (job, config) =>
    purgeConversationLexicalJob(job, config),
  );
  registerJobHandler("delete_message_lexical", (job, config) =>
    deleteMessageLexicalJob(job, config),
  );
  registerJobHandler("backfill_lexical_index", (job, config) =>
    backfillLexicalIndexJob(job, config),
  );
  registerJobHandler("prune_old_llm_request_logs", (job, config) =>
    pruneOldLlmRequestLogsJob(job, config),
  );
  registerJobHandler("prune_old_trace_events", (job, config) =>
    pruneOldTraceEventsJob(job, config),
  );
  registerJobHandler("prune_old_tool_invocations", (job, config) =>
    pruneOldToolInvocationsJob(job, config),
  );
  registerJobHandler("build_conversation_summary", async (job, config) => {
    // Stale rows enqueued before v2 was enabled must not consume the
    // `conversationSummarization` LLM budget — v2 readers do not consume
    // `memorySummaries`, mirroring the `graph_extract` gate in the memory
    // plugin's job handlers.
    if (config.memory.v2.enabled) {
      return;
    }
    await buildConversationSummaryJob(job, config);
  });
  registerJobHandler("media_processing", (job) => mediaProcessingJob(job));
  registerJobHandler("conversation_analyze", (job, config) =>
    conversationAnalyzeJob(job, config),
  );
  registerJobHandler("generate_conversation_starters", (job) =>
    generateConversationStartersJob(job),
  );
}
