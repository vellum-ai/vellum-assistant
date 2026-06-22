/**
 * Memory v3 route definitions — live-lane maintenance operations for the
 * section-lane memory model.
 *
 * The daemon owns the live shadow lanes, so the maintenance verbs run here,
 * inside the daemon process, where the in-memory lanes can be invalidated or
 * rebuilt after a write:
 *
 *   - `rebuild-index` — drop the cached lanes so the next turn rebuilds.
 *   - `backfill-sections` — one-time full embed of every page's sections into
 *     the dense store, advancing the maintain high-water mark.
 *
 * Each route's behavior lives in a small DI-friendly `handle*` function (with an
 * injectable config seam) so tests can drive it without mocking module globals.
 * The exported `RouteDefinition`s are thin adapters over those handlers.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { backfillAllSections } from "../../plugins/defaults/memory-v3-shadow/maintain-job.js";
import { invalidateLanes } from "../../plugins/defaults/memory-v3-shadow/shadow-plugin.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("memory-v3-routes");

// ---------------------------------------------------------------------------
// rebuild-index
// ---------------------------------------------------------------------------

const MemoryV3RebuildIndexResultSchema = z.object({
  ok: z.literal(true),
});
export type MemoryV3RebuildIndexResult = z.infer<
  typeof MemoryV3RebuildIndexResultSchema
>;

/**
 * Invalidate the v3 shadow lanes so the next turn rebuilds the section index
 * from the current on-disk state. Runs in-daemon so it acts on the live
 * process's cached lanes (an in-CLI call would invalidate nothing).
 */
export async function handleMemoryV3RebuildIndex(): Promise<MemoryV3RebuildIndexResult> {
  invalidateLanes();
  log.info("memory-v3 lanes invalidated (rebuild-index)");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// backfill-sections
// ---------------------------------------------------------------------------

const MemoryV3BackfillSectionsResultSchema = z.object({
  /** Pages whose sections were embedded this pass. */
  articles: z.number(),
  /** Total section points upserted across all articles. */
  sections: z.number(),
  /** Pages whose embed threw (and was contained). */
  failures: z.number(),
});
export type MemoryV3BackfillSectionsResult = z.infer<
  typeof MemoryV3BackfillSectionsResultSchema
>;

/**
 * One-time full backfill of the section dense store: embed EVERY page in the
 * index — including synthetic skill/CLI rows the incremental maintain pass
 * skips — into the `memory_v3_sections` collection, then advance the maintain
 * high-water mark so the next incremental run deltas from here. Runs in-daemon
 * so it uses the live config and so the maintain checkpoint it advances is the
 * one the daemon's incremental pass reads.
 *
 * `config` is injectable for tests; production resolves the live config.
 */
export async function handleMemoryV3BackfillSections(
  config: AssistantConfig = getConfig(),
): Promise<MemoryV3BackfillSectionsResult> {
  const outcome = await backfillAllSections(config);
  log.info(outcome, "memory-v3 section backfill complete (route)");
  return outcome;
}

// ---------------------------------------------------------------------------
// Route definitions (RouteHandlerArgs adapters over the handlers above)
// ---------------------------------------------------------------------------

/**
 * Mutating verbs require `settings.write`. `rebuild-index` invalidates the live
 * lanes and `backfill-sections` writes the dense store + advances the maintain
 * checkpoint, so a `settings.read`-only principal must not reach them.
 */
const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v3_rebuild_index",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/v3/rebuild-index",
    handler: () => handleMemoryV3RebuildIndex(),
    summary: "Invalidate the v3 lanes so the next turn rebuilds",
    tags: ["memory"],
    responseBody: MemoryV3RebuildIndexResultSchema,
  },
  {
    operationId: "memory_v3_backfill_sections",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/v3/backfill-sections",
    handler: () => handleMemoryV3BackfillSections(),
    summary:
      "One-time: embed every page's sections (incl synthetic skill/CLI rows) into the dense store",
    tags: ["memory"],
    responseBody: MemoryV3BackfillSectionsResultSchema,
  },
];
