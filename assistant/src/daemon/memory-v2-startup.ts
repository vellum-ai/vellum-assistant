// ---------------------------------------------------------------------------
// Memory v2 — daemon-startup helpers
// ---------------------------------------------------------------------------
//
// Small focused module that holds the gating + dispatch logic for v2-specific
// startup work invoked from `lifecycle.ts`. Lives in its own file so the unit
// test for the gate does not have to mount the entire lifecycle import graph.

import type { AssistantConfig } from "../config/schema.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("memory-v2-startup");

/**
 * Fire-and-forget seed of the v2 skill entries (now indexed alongside concept
 * pages in `memory_v2_concept_pages` under the `skills/<id>` slug prefix), and
 * a one-shot best-effort cleanup of the legacy `memory_v2_skills` Qdrant
 * collection. Uses a dynamic import so v2 code does not load unless the gate
 * passes. Never awaits — startup must not block on this (see
 * `assistant/CLAUDE.md` daemon startup philosophy).
 */
export function maybeSeedMemoryV2Skills(config: AssistantConfig): void {
  if (!config.memory.v2.enabled) return;
  void import("../memory/v2/skill-store.js")
    .then(({ seedV2SkillEntries }) => seedV2SkillEntries())
    .catch((err) => log.warn({ err }, "Failed to seed v2 skill entries"));
  void import("../memory/v2/qdrant.js")
    .then(({ dropLegacySkillsCollection }) => dropLegacySkillsCollection())
    .catch((err) =>
      log.warn(
        { err },
        "Failed to drop legacy memory_v2_skills collection — non-fatal",
      ),
    );
}

/**
 * Reconcile the v2 concept-page Qdrant collection with the expected schema
 * and enqueue `memory_v2_reembed` when the collection is missing data.
 * Triggers reembed in two cases:
 *  - Drift: `ensureConceptPageCollection` returned `{ migrated: true }`
 *    after destructively recreating the collection (e.g. pre-#29823
 *    schemas lacking `summary_*` named vectors).
 *  - Empty-after-create: the collection has zero points but pages exist on
 *    disk — covers crash-mid-rebuild and external Qdrant wipes.
 *
 * Awaited inline by `lifecycle.ts` so the enqueue happens before the memory
 * worker drains its first batch; the body is wrapped in try/catch so a v2
 * failure never blocks startup.
 */
export async function maybeRebuildMemoryV2Concepts(
  config: AssistantConfig,
): Promise<void> {
  if (!config.memory.v2.enabled) return;

  try {
    const {
      ensureConceptPageCollection,
      countConceptPagePoints,
      clearReembedSentinel,
    } = await import("../memory/v2/qdrant.js");
    const { hasConceptPages } = await import("../memory/v2/page-store.js");
    const { enqueueMemoryJob } = await import("../memory/jobs-store.js");

    const { migrated } = await ensureConceptPageCollection();

    let shouldReembed = migrated;
    if (!shouldReembed) {
      const points = await countConceptPagePoints();
      if (points === 0 && (await hasConceptPages(getWorkspaceDir()))) {
        shouldReembed = true;
      }
    }

    if (shouldReembed) {
      const jobId = enqueueMemoryJob("memory_v2_reembed", {});
      log.info(
        { jobId, collectionMigrated: migrated },
        "Memory v2 collection rebuild required — enqueued reembed job",
      );
      // Clear the on-disk sentinel that the qdrant ensure-path writes before
      // delete: now that reembed is queued, the cross-call signal can retire.
      // If the sentinel never existed this is a no-op.
      await clearReembedSentinel();
    }
  } catch (err) {
    log.warn(
      { err },
      "Memory v2 collection schema check failed — continuing startup; v2 retrieval may be degraded",
    );
  }
}
