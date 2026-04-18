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
 * every conversation in the workspace), so per-conversation scoping would
 * cause same-file writes from different scopes to silently overwrite each
 * other's Qdrant points (upsert dedupes by `target_type + target_id`, which
 * does not include the scope). Pinning every PKB write and search to a
 * single sentinel keeps the index consistent regardless of which
 * conversation triggered the write.
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
