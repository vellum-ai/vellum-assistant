/**
 * The memory plugin's background-job-handler contributions.
 *
 * Each entry pairs a job-queue `type` with the handler that processes it,
 * sourcing the implementation from the memory feature (`src/memory/*`) and the
 * v3 engine (`./v3/`). The memory plugin registers this array directly into the
 * worker dispatch table from its `init` hook — see `job-handler-registration.ts`
 * (and the standalone worker process, which self-registers it).
 *
 * Each handler is wrapped in an arrow that reads the imported binding at
 * dispatch time rather than capturing it eagerly, so a per-test `mock.module` of
 * the underlying handler is honored.
 */

import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../../persistence/jobs-store.js";
import { getLogger } from "../../../util/logger.js";
import type { JobHandlerEntry } from "../../types.js";
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
  embedAttachmentJob,
  embedMediaJob,
  embedSegmentJob,
  embedSummaryJob,
} from "./job-handlers/embedding.js";
import {
  deleteQdrantVectorsJob,
  rebuildIndexJob,
} from "./job-handlers/index-maintenance.js";
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
import { maintainJob as memoryV3MaintainJob } from "./v3/maintain-job.js";

const log = getLogger("memory-job-handlers");

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
 * The memory feature's per-job-type handlers, registered directly into the
 * worker dispatch table by the memory plugin's `init` hook.
 */
export const memoryJobHandlers: readonly JobHandlerEntry[] = [
  {
    type: "embed_segment",
    handler: (job) => embedSegmentJob(job),
  },
  {
    type: "embed_summary",
    handler: (job) => embedSummaryJob(job),
  },
  { type: "backfill", handler: (job, config) => backfillJob(job, config) },
  { type: "rebuild_index", handler: () => rebuildIndexJob() },
  {
    type: "delete_qdrant_vectors",
    handler: (job) => deleteQdrantVectorsJob(job),
  },
  { type: "embed_media", handler: (job) => embedMediaJob(job) },
  {
    type: "embed_attachment",
    handler: (job) => embedAttachmentJob(job),
  },
  {
    type: "embed_graph_node",
    handler: (job) => embedGraphNodeJob(job),
  },
  {
    type: "embed_pkb_file",
    handler: (job, config) => embedPkbFileJob(job, config),
  },
  {
    type: "graph_trigger_embed",
    handler: (job, config) => embedGraphTriggerJob(job, config),
  },
  {
    type: "graph_extract",
    handler: async (job, config) => {
      // Stale rows enqueued before v2 was enabled (or by any unguarded v1
      // path) must not consume embedding/extraction budget when v2 is on.
      if (config.memory.v2.enabled) {
        return;
      }
      await graphExtractJob(job, config);
    },
  },
  { type: "graph_decay", handler: (job) => graphDecayJob(job) },
  {
    type: "graph_consolidate",
    handler: (job, config) => graphConsolidateJob(job, config),
  },
  {
    type: "graph_pattern_scan",
    handler: (job, config) => graphPatternScanJob(job, config),
  },
  {
    type: "graph_narrative_refine",
    handler: (job, config) => graphNarrativeRefineJob(job, config),
  },
  { type: "graph_bootstrap", handler: () => bootstrapFromHistory() },
  {
    type: "embed_concept_page",
    handler: (job, config) => embedConceptPageJob(job, config),
  },
  {
    type: "memory_v2_sweep",
    handler: (job, config) => memoryV2SweepJob(job, config),
  },
  {
    type: "memory_v2_consolidate",
    handler: (job, config) => memoryV2ConsolidateJob(job, config),
  },
  {
    type: "memory_v2_migrate",
    handler: (job, config) => memoryV2MigrateJob(job, config),
  },
  {
    type: "memory_v2_reembed",
    handler: (job, config) => memoryV2ReembedJob(job, config),
  },
  {
    type: "memory_v2_activation_recompute",
    handler: (job, config) => memoryV2ActivationRecomputeJob(job, config),
  },
  {
    type: "memory_v3_maintain",
    handler: (job, config) => memoryV3MaintainJob(job, config),
  },
  {
    type: "memory_retrospective",
    handler: (job, config) => memoryRetrospectiveJob(job, config),
  },
];
