// ---------------------------------------------------------------------------
// Auto-analyze — conversation_analyze job handler
//
// Bridges the jobs worker to the shared analyzeConversation() service. The
// service imports its dependencies (getOrCreateConversation, assistantEventHub)
// directly — no DI singleton required.
//
// The service itself distinguishes manual vs. auto triggers: this handler
// always invokes with `trigger: "auto"`, so the rolling analysis conversation
// logic and recursion guard apply.
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../config/types.js";
import { analyzeConversation } from "../runtime/services/analyze-conversation.js";
import { getLogger } from "../util/logger.js";
import { enqueueAutoAnalysisIfEnabled } from "./auto-analysis-enqueue.js";
import type { MemoryJob } from "./jobs-store.js";

const log = getLogger("conversation-analyze-job");

export async function conversationAnalyzeJob(
  job: MemoryJob<{ conversationId?: string }>,
  _config: AssistantConfig,
): Promise<void> {
  const { conversationId } = job.payload;
  if (!conversationId) {
    log.warn({ jobId: job.id }, "Skipping job: missing conversationId");
    return;
  }

  const result = await analyzeConversation(conversationId, {
    trigger: "auto",
  });
  if ("error" in result) {
    log.warn(
      { jobId: job.id, conversationId, error: result.error },
      "Auto-analysis service rejected source conversation",
    );
    return;
  }
  if (result.skipped) {
    // The rolling analysis conversation was still processing a prior run, so
    // this invocation was a no-op. Schedule a debounced follow-up ourselves
    // — otherwise, if no later batch/idle/lifecycle trigger arrives (e.g.
    // the conversation goes quiet after a long in-flight analysis), new
    // source messages would stay un-analyzed indefinitely.
    enqueueAutoAnalysisIfEnabled({ conversationId, trigger: "idle" });
    log.debug(
      { jobId: job.id, conversationId },
      "Auto-analysis skipped (rolling conversation busy); requeued follow-up",
    );
  }
}
