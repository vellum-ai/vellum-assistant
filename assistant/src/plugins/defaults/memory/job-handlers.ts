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

import {
  isMemoryV1Active,
  usesConceptPageMemory,
} from "../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../../persistence/jobs-store.js";
import type { JobHandlerEntry } from "../../types.js";
import {
  embedGraphNodeJob,
  embedGraphTriggerJob,
} from "./graph/graph-search.js";
import { embedConceptPageJob } from "./jobs/embed-concept-page.js";
import { getLogger } from "./logging.js";
import { memoryRetrospectiveJob } from "./memory-retrospective-job.js";
import { skillCardInsertJob } from "./memory-retrospective-skill-card.js";
import { memoryRetrospectiveSweepJob } from "./memory-retrospective-sweep.js";
import { memoryV2ConsolidateJob } from "./substrate/consolidation-job.js";
import { memoryV2ReembedJob } from "./substrate/reembed-job.js";
import { memoryV2SweepJob } from "./substrate/sweep-job.js";
import { pkbCompactionJob, pkbFilingJob } from "./v1/filing-jobs.js";
import { bootstrapFromHistory } from "./v1/graph/bootstrap.js";
import { runConsolidation } from "./v1/graph/consolidation.js";
import { runDecayTick } from "./v1/graph/decay.js";
import { graphExtractJob } from "./v1/graph/extraction-job.js";
import { runNarrativeRefinement } from "./v1/graph/narrative.js";
import { runPatternScan } from "./v1/graph/pattern-scan.js";
import { backfillJob } from "./v1/job-handlers/backfill.js";
import {
  embedAttachmentJob,
  embedMediaJob,
  embedSegmentJob,
  embedSummaryJob,
} from "./v1/job-handlers/embedding.js";
import {
  deleteQdrantVectorsJob,
  rebuildIndexJob,
  sweepOrphanedGraphNodePointsJob,
} from "./v1/job-handlers/index-maintenance.js";
import { embedPkbFileJob } from "./v1/jobs/embed-pkb-file.js";
import {
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
} from "./v2/backfill-jobs.js";
import { maintainJob as memoryV3MaintainJob } from "./v3/maintain-job.js";

const log = getLogger("memory-job-handlers");

// ── Graph lifecycle job handlers ──────────────────────────────────

/**
 * Tier gate shared by the v1 graph lifecycle handlers below. These jobs
 * mutate (and some LLM-process into) the legacy v1 graph, which only the v1
 * tier reads — so a stale or hand-enqueued row claimed while v1 is not the
 * active memory tier must complete as a logged no-op instead of doing that
 * work. Returns true when the row should be skipped.
 */
function isStaleV1GraphJob(job: MemoryJob, config: AssistantConfig): boolean {
  if (isMemoryV1Active(config)) {
    return false;
  }
  log.info(
    { jobId: job.id, type: job.type },
    "Skipping v1 graph job — the legacy graph is not the active memory tier",
  );
  return true;
}

function graphDecayJob(job: MemoryJob, config: AssistantConfig): void {
  if (isStaleV1GraphJob(job, config)) {
    return;
  }
  const result = runDecayTick();
  log.info({ jobId: job.id, ...result }, "Graph decay tick complete");
}

async function graphConsolidateJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  if (isStaleV1GraphJob(job, config)) {
    return;
  }
  const result = await runConsolidation(config);
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
  if (isStaleV1GraphJob(job, config)) {
    return;
  }
  const result = await runPatternScan(config);
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
  if (isStaleV1GraphJob(job, config)) {
    return;
  }
  const result = await runNarrativeRefinement(config);
  log.info(
    {
      jobId: job.id,
      updated: result.nodesUpdated,
      arcs: result.arcsIdentified,
    },
    "Graph narrative refinement complete",
  );
}

async function graphBootstrapJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  if (isStaleV1GraphJob(job, config)) {
    return;
  }
  await bootstrapFromHistory();
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
  {
    type: "sweep_orphaned_graph_node_points",
    handler: () => sweepOrphanedGraphNodePointsJob(),
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
      // Stale rows enqueued by any unguarded v1 path must not consume
      // embedding/extraction budget while concept-page memory is active.
      if (usesConceptPageMemory(config.memory)) {
        return;
      }
      await graphExtractJob(job, config);
    },
  },
  { type: "graph_decay", handler: (job, config) => graphDecayJob(job, config) },
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
  {
    type: "graph_bootstrap",
    handler: (job, config) => graphBootstrapJob(job, config),
  },
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
    type: "pkb_filing",
    handler: (job) => pkbFilingJob(job),
  },
  {
    type: "pkb_compaction",
    handler: () => pkbCompactionJob(),
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
  {
    type: "memory_retrospective_sweep",
    handler: (job, config) => memoryRetrospectiveSweepJob(job, config),
  },
  {
    type: "skill_card_insert",
    handler: (job) => skillCardInsertJob(job),
  },
];
