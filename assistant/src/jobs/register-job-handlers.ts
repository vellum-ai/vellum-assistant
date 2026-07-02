import { buildConversationSummaryJob } from "../conversations/job-handlers/summarization.js";
import { generateConversationStartersJob } from "../home/job-handlers/conversation-starters.js";
import { mediaProcessingJob } from "../media/job-handlers/media-processing.js";
import {
  pruneOldConversationsJob,
  pruneOldLlmRequestLogsJob,
  pruneOldToolInvocationsJob,
  pruneOldTraceEventsJob,
} from "../persistence/job-handlers/cleanup.js";
import {
  deleteMessageLexicalJob,
  indexMessageLexicalJob,
  purgeConversationLexicalJob,
} from "../persistence/job-handlers/message-lexical.js";
import { backfillLexicalIndexJob } from "../persistence/job-handlers/message-lexical-backfill.js";
import { registerJobHandler } from "../persistence/jobs-worker.js";
import {
  registerDefaultPluginJobHandlers,
  registerDefaultPluginPersistenceHooks,
} from "../plugins/defaults/index.js";
import { getRegisteredJobHandlers } from "../plugins/job-handler-registry.js";
import { conversationAnalyzeJob } from "../runtime/services/conversation-analyze-job.js";

/**
 * Register every background-job handler into the worker's dispatch table
 * (`registerJobHandler` in `persistence/jobs-worker`).
 *
 * Plugin-contributed handlers (memory, and any future plugin) flow through the
 * global job-handler registry; the remaining handlers belong to domains that are
 * not plugins (persistence cleanup, conversations, media, home, runtime) and are
 * wired here directly.
 *
 * Idempotent: registering a type twice overwrites with the same handler, so
 * repeated calls (e.g. from the daemon supervisor and the standalone worker
 * process) are safe.
 */
export function registerMemoryJobHandlers(): void {
  // Forward plugin-contributed job handlers into the worker. Ensure the default
  // plugins' contributions are in the registry first: the standalone worker
  // process does not run plugin bootstrap, so it must self-register the defaults
  // here. Idempotent — on the daemon path bootstrap has already registered them
  // (plus any user plugins, which this union also picks up).
  registerDefaultPluginJobHandlers();
  // The standalone worker runs fork-based memory retrospectives, which carry
  // per-conversation memory state through the persistence-lifecycle seam. The
  // daemon wires that seam at bootstrap; the worker must self-register it here
  // too, or `onConversationForked` is the no-op and the retrospective fork
  // silently drops the carried activation/injection/graph/retrospective state.
  registerDefaultPluginPersistenceHooks();
  for (const { type, handler } of getRegisteredJobHandlers()) {
    registerJobHandler(type, handler);
  }

  // Non-plugin domain handlers. Each is registered behind an arrow that reads
  // the imported binding at dispatch time rather than capturing it eagerly, so a
  // per-test `mock.module` of the underlying handler is honored.
  registerJobHandler("prune_old_conversations", (job, config) =>
    pruneOldConversationsJob(job, config),
  );
  // Message-content lexical indexing powers regular message search — host
  // infrastructure, not a memory-plugin feature (the jobs merely share the
  // background job queue).
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
