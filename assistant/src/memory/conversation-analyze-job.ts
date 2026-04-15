// ---------------------------------------------------------------------------
// Auto-analyze — conversation_analyze job handler
//
// Bridges the jobs worker to the shared analyzeConversation() service. The
// deps bundle is stashed on a module singleton during daemon startup; if it
// isn't set yet we skip this iteration. The next batch / idle / lifecycle
// trigger from `enqueueAutoAnalysisIfEnabled()` will produce a fresh job
// once the daemon has fully started.
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
    // Daemon hasn't finished startup. Return without throwing — a plain
    // Error here would be classified as fatal by `classifyError()` and the
    // worker would mark the job permanently failed. Throwing
    // `BackendUnavailableError` would defer, but defer counters cap out and
    // would still permanently fail in the worst case. Since
    // `enqueueAutoAnalysisIfEnabled()` re-enqueues on the next batch / idle
    // / lifecycle trigger, dropping this iteration is the safest choice and
    // avoids retry storms during slow daemon startup.
    log.warn(
      { jobId: job.id, conversationId },
      "Skipping job: analysis deps not yet initialized; will retrigger",
    );
    return;
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
