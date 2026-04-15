// ---------------------------------------------------------------------------
// Auto-analyze — conversation_analyze job handler
//
// Bridges the jobs worker to the shared analyzeConversation() service. The
// deps bundle is stashed on a module singleton during daemon startup; if it
// isn't set yet we throw so the worker reschedules via its normal retry
// mechanism.
//
// The service itself distinguishes manual vs. auto triggers: this handler
// always invokes with `trigger: "auto"`, so the rolling analysis conversation
// logic and recursion guard apply.
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../config/types.js";
import { analyzeConversation } from "../runtime/services/analyze-conversation.js";
import { getAnalysisDeps } from "../runtime/services/analyze-deps-singleton.js";
import { getLogger } from "../util/logger.js";
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

  const deps = getAnalysisDeps();
  if (!deps) {
    // Daemon hasn't finished startup; throw so the worker reschedules.
    throw new Error("Analysis deps not yet initialized");
  }

  const result = await analyzeConversation(conversationId, deps, {
    trigger: "auto",
  });
  if ("error" in result) {
    log.warn(
      { jobId: job.id, conversationId, error: result.error },
      "Auto-analysis service rejected source conversation",
    );
  }
}
