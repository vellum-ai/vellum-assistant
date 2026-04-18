/**
 * Shared types and constants for PKB (Personal Knowledge Base) indexing.
 *
 * Scaffolding for upcoming PKB Qdrant indexing work — consumers (search,
 * index writer) land in later PRs.
 */

export const PKB_TARGET_TYPE = "pkb_file" as const;

/**
 * Sentinel `memory_scope_id` under which ALL PKB points are indexed and
 * searched. PKB files live at workspace level (one copy on disk shared by
 * every conversation in the workspace), so every writer — the `remember`
 * tool, file writes, startup reconciliation — must pin to the same scope or
 * search would return a fragmented view of the workspace's knowledge base.
 *
 * Note: `indexPkbFile` now scope-namespaces each chunk's `target_id` (see
 * `pkb-index.ts`), so a stray per-conversation scope would no longer clobber
 * another scope's vectors at the Qdrant level. The sentinel is still required
 * for the semantic reason above: PKB is workspace-shared, not per-scope.
 */
export const PKB_WORKSPACE_SCOPE = "_pkb_workspace" as const;

export interface PkbSearchResult {
  path: string;
  score: number;
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
