/**
 * Shared types and constants for PKB (Personal Knowledge Base) indexing.
 *
 * Scaffolding for upcoming PKB Qdrant indexing work — consumers (search,
 * index writer) land in later PRs.
 */

export const PKB_TARGET_TYPE = "pkb_file" as const;

/**
 * Sentinel `memory_scope_id` under which ALL PKB points are indexed and
 * searched. PKB files are a workspace-shared resource: one copy on disk is
 * visible to every conversation in the workspace, so every writer — the
 * `remember` tool, file writes, startup reconciliation — pins to this scope
 * so search returns a single coherent view of the workspace's knowledge base
 * instead of a per-conversation fragment.
 */
export const PKB_WORKSPACE_SCOPE = "_pkb_workspace" as const;

export interface PkbSearchResult {
  path: string;
  /**
   * Cosine similarity from the dense-only Qdrant query. Always present —
   * acts as the threshold gate for hint eligibility since it lives on the
   * stable `[0, 1]` cosine scale regardless of whether sparse was provided.
   */
  denseScore: number;
  /**
   * Qdrant RRF fusion score from the hybrid (dense + sparse) query. Present
   * only when a sparse vector was supplied to `searchPkbFiles`. Lives on a
   * different (much smaller) scale than `denseScore`, so it is used for
   * ranking within the gated set — not for quality thresholding.
   */
  hybridScore?: number;
  snippet?: string;
}

export interface PkbIndexEntry {
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkIndex: number;
}

export interface PkbIndexPayload {
  target_type: typeof PKB_TARGET_TYPE;
  target_id: string;
  path: string;
  mtime_ms: number;
  chunk_index: number;
  content_hash: string;
  memory_scope_id: string;
}
