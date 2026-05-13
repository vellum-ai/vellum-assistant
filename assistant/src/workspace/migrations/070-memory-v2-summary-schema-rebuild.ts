import type { WorkspaceMigration } from "./types.js";

/**
 * Audit-only entry for the v2 concept-page schema upgrade introduced in PR
 * #29823 (summary_dense / summary_sparse named vectors). The destructive
 * collection rebuild and reembed enqueue both run inside the daemon at
 * Qdrant init time — see `maybeRebuildMemoryV2Concepts` in
 * `assistant/src/daemon/memory-v2-startup.ts`. The "exactly-once" fence is
 * per-collection schema introspection, not per-workspace checkpoint, so
 * users who wipe Qdrant separately still get re-rebuilt without resetting
 * any workspace flag.
 *
 * This migration exists so the registry chronology records the schema
 * upgrade alongside the release that introduced it.
 */
export const memoryV2SummarySchemaRebuildMigration: WorkspaceMigration = {
  id: "070-memory-v2-summary-schema-rebuild",
  description:
    "Audit entry: v2 concept-page Qdrant collection now carries summary_dense / summary_sparse named vectors. Rebuild + reembed handled by the daemon's startup hook.",

  run(_workspaceDir: string): void {
    // No-op: the actual rebuild lives in the Qdrant client layer where the
    // collection schema is owned. Workspace migrations cannot touch Qdrant
    // (they run before it starts and must be self-contained per
    // assistant/src/workspace/migrations/AGENTS.md).
  },

  down(_workspaceDir: string): void {
    // Forward-only: schema rollbacks happen outside the migration system.
  },
};
