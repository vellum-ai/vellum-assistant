// ---------------------------------------------------------------------------
// Auto-analyze — conversation_analyze job handler
//
// Bridges the jobs worker to the shared analyzeConversation() service. The
// deps bundle is stashed on a module singleton during daemon startup; if it
// isn't set yet the handler throws BackendUnavailableError so the worker
// defers with exponential backoff until deps become available.
//
// The service itself distinguishes manual vs. auto triggers: this handler
// always invokes with `trigger: "auto"`, so the rolling analysis conversation
// logic and recursion guard apply.
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../config/types.js";
import { analyzeConversation } from "../runtime/services/analyze-conversation.js";
import { getAnalysisDeps } from "../runtime/services/analyze-deps-singleton.js";
import { BackendUnavailableError } from "../util/errors.js";
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

  const deps = getAnalysisDeps();
  if (!deps) {
    // Daemon hasn't finished startup. Throw BackendUnavailableError so the
    // worker defers the job with exponential backoff instead of completing
    // it. Returning success here would permanently drop the job via
    // completeMemoryJob — conversations with a pre-existing queued job
    // during startup and no subsequent activity would never be analyzed.
    // The deferral budget (50 × up to 5min backoff) is generous enough to
    // outlast any realistic startup delay.
    log.warn(
      { jobId: job.id, conversationId },
      "Deferring job: analysis deps not yet initialized",
    );
    throw new BackendUnavailableError(
      "Analysis deps not yet initialized during daemon startup",
    );
  }

  const result = await analyzeConversation(conversationId, deps, {
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
