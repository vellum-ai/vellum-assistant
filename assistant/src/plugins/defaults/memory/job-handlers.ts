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
 *
 * The table is grouped into labeled per-tier sections (V1 / SUBSTRATE / V2
 * ENGINE / V3 / RETROSPECTIVE) so retiring a tier is deleting its section and
 * its import group. Registration keys off `type` alone, so the literal order
 * is a readability convenience.
 */

import { isMemoryV1Active } from "../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../../persistence/jobs-store.js";
import type { JobHandlerEntry, JobQueueResolution } from "../../types.js";
// The all-tier graph store: `embedGraphNodeJob` serves the V1 section,
// `embedGraphTriggerJob` the SUBSTRATE one.
import {
  embedGraphNodeJob,
  embedGraphTriggerJob,
} from "./graph/graph-search.js";
// SUBSTRATE (v2+v3).
import { embedConceptPageJob } from "./jobs/embed-concept-page.js";
import { getLogger } from "./logging.js";
// RETROSPECTIVE (all tiers).
import {
  memoryRetrospectiveJob,
  type MemoryRetrospectiveOutcome,
} from "./memory-retrospective-job.js";
import { skillCardInsertJob } from "./memory-retrospective-skill-card.js";
import { memoryRetrospectiveSweepJob } from "./memory-retrospective-sweep.js";
// SUBSTRATE (v2+v3).
import {
  type ConsolidationOutcome,
  memoryV2ConsolidateJob,
} from "./substrate/consolidation-job.js";
import { memoryV2ReembedJob } from "./substrate/reembed-job.js";
import { memoryV2SweepJob } from "./substrate/sweep-job.js";
// V1 — delete with v1.
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
// V2 ENGINE — delete with v2.
import {
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
} from "./v2/backfill-jobs.js";
// V3.
import { maintainJob as memoryV3MaintainJob } from "./v3/maintain-job.js";

const log = getLogger("memory-job-handlers");

// ── Graph lifecycle job handlers ──────────────────────────────────

/**
 * Tier gate shared by the v1 graph handlers below (the lifecycle jobs and
 * `graph_extract`). These jobs mutate — and some LLM-process into — the legacy
 * v1 graph, which only the v1 tier reads, so a stale or hand-enqueued row
 * claimed while v1 is not the active memory tier must complete as a logged
 * no-op instead of doing that work. Returns true when the row should be
 * skipped.
 *
 * The condition is `isMemoryV1Active` and nothing else — the same predicate
 * `processJob` applies to `V1_QDRANT_JOB_TYPES` in `jobs-worker.ts`, so every
 * v1 job type answers to one definition of "v1 is the live tier". That
 * predicate's docstring carries the memory-off semantics the two share: memory
 * being off is not v1, so v1 work is skipped there exactly as it is under the
 * concept-page substrate.
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
  // V1 — delete with v1.
  // Segment/summary/media embedding, the Qdrant index-maintenance jobs, the
  // graph lifecycle, and PKB filing. Their stale-row guards live at dispatch
  // (`V1_QDRANT_JOB_TYPES` in `jobs-worker.ts`), in `isStaleV1GraphJob` above,
  // and at the `jobs-worker.ts` scheduling sites — all three on the one
  // `isMemoryV1Active` condition.
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
    type: "graph_extract",
    handler: async (job, config) => {
      // Stale rows enqueued by any unguarded v1 path must not consume
      // embedding/extraction budget while v1 is not the live tier.
      if (isStaleV1GraphJob(job, config)) {
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
    type: "pkb_filing",
    handler: (job) => pkbFilingJob(job),
  },
  {
    type: "pkb_compaction",
    handler: () => pkbCompactionJob(),
  },

  // SUBSTRATE (v2+v3).
  // Concept-page embedding, the buffer sweep and consolidator, and the
  // corpus reembed — shared by the v2 injection engine and v3, so they
  // outlive v1 and v2 alike. `graph_trigger_embed` deliberately lives here
  // rather than with the v1 graph jobs: it embeds trigger text the substrate
  // reads (locked by `__tests__/jobs-worker-v2-graph-trigger-embed.test.ts`).
  {
    type: "graph_trigger_embed",
    handler: (job, config) => embedGraphTriggerJob(job, config),
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
    handler: async (job, config) =>
      resolveConsolidationOutcome(await memoryV2ConsolidateJob(job, config)),
  },
  {
    type: "memory_v2_reembed",
    handler: (job, config) => memoryV2ReembedJob(job, config),
  },

  // V2 ENGINE — delete with v2.
  // Operator-triggered backfills owned by the activation/router engine: the
  // one-shot v1→v2 synthesis and the persisted-activation recompute. The job
  // types share the `memory_v2_` prefix with the substrate entries above, but
  // the work is engine-local.
  {
    type: "memory_v2_migrate",
    handler: (job, config) => memoryV2MigrateJob(job, config),
  },
  {
    type: "memory_v2_activation_recompute",
    handler: (job, config) => memoryV2ActivationRecomputeJob(job, config),
  },

  // V3.
  // Topic-tree self-maintenance; the handler no-ops when v3 is not live.
  {
    type: "memory_v3_maintain",
    handler: (job, config) => memoryV3MaintainJob(job, config),
  },

  // RETROSPECTIVE (all tiers).
  // The retrospective pass and its cross-conversation sweep are tier-agnostic
  // and survive every tier deletion. `skill_card_insert` is emitted only on
  // v3 but is owned by the retrospective, so it groups here.
  {
    type: "memory_retrospective",
    handler: async (job, config) =>
      resolveRetrospectiveOutcome(await memoryRetrospectiveJob(job, config)),
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

/**
 * Terminal `last_error` for a retrospective row whose source conversation
 * stayed mid-turn through the whole deferral budget. Named so the dead-letter
 * row points at the stranded `processing_started_at` flag rather than a
 * generic backend message; the sweep re-enqueues a fresh row once the source
 * is eligible again.
 */
const SOURCE_PROCESSING_EXHAUSTED_MESSAGE =
  "source conversation stayed mid-turn through the deferral budget " +
  "(processing_started_at may be stranded); the retrospective sweep will re-enqueue";

/**
 * Translate the retrospective handler's domain outcome into the queue
 * resolution persisted on its job row. The domain outcome is the source of
 * truth for what happened; this mapping owns only how the row reads
 * afterward:
 *
 * - benign no-ops and successful runs complete;
 * - a mid-turn source defers the SAME row on the bounded deferral counter
 *   (the turn-end trigger check's upsert coalesces onto this row, so the
 *   event-driven retry keeps its immediacy) instead of completing it and
 *   re-upserting a fresh row per attempt;
 * - a failed or unusable wake dead-letters the row with an honest
 *   `last_error`. Retry stays event-driven (cooldown + re-enqueue), so the
 *   queue's attempt budget is deliberately not double-driving it.
 */
function resolveRetrospectiveOutcome(
  outcome: MemoryRetrospectiveOutcome,
): JobQueueResolution {
  switch (outcome.kind) {
    case "source_processing": {
      return {
        queueResolution: "deferred",
        deferralExhaustedMessage: SOURCE_PROCESSING_EXHAUSTED_MESSAGE,
      };
    }
    case "wake_failed": {
      return {
        queueResolution: "failed",
        errorMessage: `retrospective wake failed: ${outcome.reason ?? "unknown"}`,
      };
    }
    case "no_usable_output": {
      return {
        queueResolution: "failed",
        errorMessage: `retrospective run produced no usable output: ${outcome.reason ?? "unknown"}`,
      };
    }
    default: {
      return { queueResolution: "completed" };
    }
  }
}

/**
 * Translate the consolidation handler's domain outcome into the queue
 * resolution persisted on its job row. A `run_failed` dead-letters the row
 * with the failure reason; retry cadence is owned by the durable
 * consolidation failure-state checkpoint (`memory_v2_consolidate_failure_state`),
 * not the queue's attempt budget. Skips (disabled / locked / empty buffer)
 * and successful runs complete.
 */
function resolveConsolidationOutcome(
  outcome: ConsolidationOutcome,
): JobQueueResolution {
  if (outcome.kind === "run_failed") {
    return {
      queueResolution: "failed",
      errorMessage: `consolidation run failed: ${outcome.reason ?? "unknown"}`,
    };
  }
  return { queueResolution: "completed" };
}
