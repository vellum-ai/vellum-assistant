import type { AssistantConfig } from "../config/types.js";
import type { MemoryJob } from "../persistence/jobs-store.js";
import { registerJobHandler } from "../persistence/jobs-worker.js";
import { maintainJob as memoryV3MaintainJob } from "../plugins/defaults/memory/v3/maintain-job.js";
import { conversationAnalyzeJob } from "../runtime/services/conversation-analyze-job.js";
import { getLogger } from "../util/logger.js";
import { bootstrapFromHistory } from "./graph/bootstrap.js";
import { runConsolidation } from "./graph/consolidation.js";
import { runDecayTick } from "./graph/decay.js";
import { graphExtractJob } from "./graph/extraction-job.js";
import {
  embedGraphNodeJob,
  embedGraphTriggerJob,
} from "./graph/graph-search.js";
import { runNarrativeRefinement } from "./graph/narrative.js";
import { runPatternScan } from "./graph/pattern-scan.js";
import { backfillJob } from "./job-handlers/backfill.js";
import {
  pruneOldConversationsJob,
  pruneOldLlmRequestLogsJob,
  pruneOldTraceEventsJob,
} from "./job-handlers/cleanup.js";
import { generateConversationStartersJob } from "./job-handlers/conversation-starters.js";
import {
  embedAttachmentJob,
  embedMediaJob,
  embedSegmentJob,
  embedSummaryJob,
} from "./job-handlers/embedding.js";
import {
  deleteQdrantVectorsJob,
  rebuildIndexJob,
} from "./job-handlers/index-maintenance.js";
import { mediaProcessingJob } from "./job-handlers/media-processing.js";
import { buildConversationSummaryJob } from "./job-handlers/summarization.js";
import { embedConceptPageJob } from "./jobs/embed-concept-page.js";
import { embedPkbFileJob } from "./jobs/embed-pkb-file.js";
import { memoryRetrospectiveJob } from "./memory-retrospective-job.js";
import {
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
  memoryV2ReembedJob,
} from "./v2/backfill-jobs.js";
import { memoryV2ConsolidateJob } from "./v2/consolidation-job.js";
import { memoryV2SweepJob } from "./v2/sweep-job.js";

const log = getLogger("memory-jobs-worker");

// ── Graph lifecycle job handlers ──────────────────────────────────

function graphDecayJob(job: MemoryJob): void {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = runDecayTick(scopeId);
  log.info({ jobId: job.id, ...result }, "Graph decay tick complete");
}

async function graphConsolidateJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runConsolidation(scopeId, config);
  log.info(
    {
      jobId: job.id,
      updated: result.totalUpdated,
      deleted: result.totalDeleted,
      mergeEdges: result.totalMergeEdges,
    },
    "Graph consolidation complete",
  );
}

async function graphPatternScanJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runPatternScan(scopeId, config);
  log.info(
    {
      jobId: job.id,
      patterns: result.patternsDetected,
      edges: result.edgesCreated,
    },
    "Graph pattern scan complete",
  );
}

async function graphNarrativeRefineJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runNarrativeRefinement(scopeId, config);
  log.info(
    {
      jobId: job.id,
      updated: result.nodesUpdated,
      arcs: result.arcsIdentified,
    },
    "Graph narrative refinement complete",
  );
}

/**
 * Wire the memory feature's per-job-type handlers into the generic
 * {@link registerJobHandler} registry owned by `persistence/jobs-worker`.
 *
 * Idempotent: registering a type twice overwrites with the same handler, so
 * repeated calls (e.g. from the daemon supervisor and the standalone worker
 * process) are safe.
 */
export function registerMemoryJobHandlers(): void {
  // Each handler is registered behind an arrow that reads the imported binding
  // at dispatch time rather than capturing it eagerly, so a per-test
  // `mock.module` of the underlying handler is honored.
  registerJobHandler("embed_segment", (job, config) =>
    embedSegmentJob(job, config),
  );
  registerJobHandler("embed_summary", (job, config) =>
    embedSummaryJob(job, config),
  );
  registerJobHandler("prune_old_conversations", (job, config) =>
    pruneOldConversationsJob(job, config),
  );
  registerJobHandler("prune_old_llm_request_logs", (job, config) =>
    pruneOldLlmRequestLogsJob(job, config),
  );
  registerJobHandler("prune_old_trace_events", (job, config) =>
    pruneOldTraceEventsJob(job, config),
  );
  registerJobHandler("build_conversation_summary", async (job, config) => {
    // Stale rows enqueued before v2 was enabled must not consume the
    // `conversationSummarization` LLM budget — v2 readers do not consume
    // `memorySummaries`, mirroring the `graph_extract` gate below.
    if (config.memory.v2.enabled) return;
    await buildConversationSummaryJob(job, config);
  });
  registerJobHandler("backfill", (job, config) => backfillJob(job, config));
  registerJobHandler("rebuild_index", () => rebuildIndexJob());
  registerJobHandler("delete_qdrant_vectors", (job) =>
    deleteQdrantVectorsJob(job),
  );
  registerJobHandler("media_processing", (job) => mediaProcessingJob(job));
  registerJobHandler("embed_media", (job, config) =>
    embedMediaJob(job, config),
  );
  registerJobHandler("embed_attachment", (job, config) =>
    embedAttachmentJob(job, config),
  );
  registerJobHandler("embed_graph_node", (job, config) =>
    embedGraphNodeJob(job, config),
  );
  registerJobHandler("embed_pkb_file", (job, config) =>
    embedPkbFileJob(job, config),
  );
  registerJobHandler("graph_trigger_embed", (job, config) =>
    embedGraphTriggerJob(job, config),
  );
  registerJobHandler("graph_extract", async (job, config) => {
    // Stale rows enqueued before v2 was enabled (or by any unguarded v1
    // path) must not consume embedding/extraction budget when v2 is on.
    if (config.memory.v2.enabled) return;
    await graphExtractJob(job, config);
  });
  registerJobHandler("conversation_analyze", (job, config) =>
    conversationAnalyzeJob(job, config),
  );
  registerJobHandler("graph_decay", (job) => graphDecayJob(job));
  registerJobHandler("graph_consolidate", (job, config) =>
    graphConsolidateJob(job, config),
  );
  registerJobHandler("graph_pattern_scan", (job, config) =>
    graphPatternScanJob(job, config),
  );
  registerJobHandler("graph_narrative_refine", (job, config) =>
    graphNarrativeRefineJob(job, config),
  );
  registerJobHandler("generate_conversation_starters", (job) =>
    generateConversationStartersJob(job),
  );
  registerJobHandler("graph_bootstrap", () => bootstrapFromHistory());
  registerJobHandler("embed_concept_page", (job, config) =>
    embedConceptPageJob(job, config),
  );
  registerJobHandler("memory_v2_sweep", (job, config) =>
    memoryV2SweepJob(job, config),
  );
  registerJobHandler("memory_v2_consolidate", (job, config) =>
    memoryV2ConsolidateJob(job, config),
  );
  registerJobHandler("memory_v2_migrate", (job, config) =>
    memoryV2MigrateJob(job, config),
  );
  registerJobHandler("memory_v2_reembed", (job, config) =>
    memoryV2ReembedJob(job, config),
  );
  registerJobHandler("memory_v2_activation_recompute", (job, config) =>
    memoryV2ActivationRecomputeJob(job, config),
  );
  registerJobHandler("memory_v3_maintain", (job, config) =>
    memoryV3MaintainJob(job, config),
  );
  registerJobHandler("memory_retrospective", (job, config) =>
    memoryRetrospectiveJob(job, config),
  );
}
