/**
 * Memory substrate — `memory_v2_reembed` job handler.
 *
 * Shared by the v2 injection engine and memory-v3; active whenever
 * `usesConceptPageMemory()` holds.
 *
 * Fans out an `embed_concept_page` job per concept-page slug. Enqueued by the
 * consolidation job's follow-ups, boot maintenance, the embedding reconciler,
 * and workspace migrations that need every page re-indexed.
 */

import type { AssistantConfig } from "../../../../config/types.js";
import type { MemoryJob } from "../../../../persistence/jobs-store.js";
import { enqueueEmbedConceptPageJob } from "../jobs/embed-concept-page.js";
import { getLogger } from "../logging.js";
import { getWorkspaceDir } from "../paths.js";
import { listPages } from "./page-store.js";

const log = getLogger("memory-v2-reembed");

/**
 * Job handler: enqueue an `embed_concept_page` job per concept-page slug.
 * Each enqueue coalesces with an already-pending job for the same slug, so
 * stacked reembed runs converge on at most one pending embed per page.
 *
 * Returns the number of pages fanned out (enqueue attempts, not necessarily
 * fresh rows). Callers (and tests) use the return value to assert progress
 * without inspecting the job table directly.
 *
 * Note on meta files: `essentials.md` / `threads.md` / `recent.md` /
 * `buffer.md` are direct-injected into the system prompt every turn via
 * `_autoinject.md`. They are NOT enqueued for embedding here — their slugs
 * (`__essentials__` etc.) contain underscores that the concept-page slug
 * validator rejects (`[a-z0-9][a-z0-9-]*`), and they live at `memory/<name>.md`
 * rather than `memory/concepts/<name>.md`, so path resolution would also miss.
 * Embedding them would be redundant with the direct injection regardless.
 */
export async function memoryV2ReembedJob(
  _job: MemoryJob,
  _config: AssistantConfig,
): Promise<number> {
  const workspaceDir = getWorkspaceDir();
  const slugs = await listPages(workspaceDir);

  for (const slug of slugs) {
    enqueueEmbedConceptPageJob({ slug });
  }

  log.info(
    { conceptPages: slugs.length, total: slugs.length },
    "Memory v2 reembed enqueued",
  );
  return slugs.length;
}
