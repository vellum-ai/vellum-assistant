/**
 * PKB (Personal Knowledge Base) filesystem indexing primitives.
 *
 * Provides the low-level building blocks used by the PKB job handler and
 * startup reconciliation:
 *   - `scanPkbFiles`: recursively walk a PKB root and emit one entry per chunk.
 *   - `chunkPkbFile`: split a markdown file into retrieval-friendly chunks.
 *   - `indexPkbFile`: embed each chunk and upsert it to Qdrant.
 *   - `deletePkbFilePoints`: remove every Qdrant point for a given file.
 *
 * Consumers (job queue wiring, startup scan) land in later PRs.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { getConfig } from "../../config/loader.js";
import { embedAndUpsert } from "../job-utils.js";
import { withQdrantBreaker } from "../qdrant-circuit-breaker.js";
import { getQdrantClient } from "../qdrant-client.js";
import type { PkbIndexEntry } from "./types.js";
import { PKB_TARGET_TYPE } from "./types.js";

/** Files larger than this are split into chunks for retrieval. */
const WHOLE_FILE_THRESHOLD = 8000;

/** Character-window size when falling back for unstructured content. */
const CHAR_WINDOW_SIZE = 4000;

/**
 * Recursively walk `pkbRoot` and return one `PkbIndexEntry` per chunk of
 * every `*.md` file found. Paths in the returned entries are relative to
 * `pkbRoot`; mtime is read from the filesystem and `contentHash` is the
 * first 16 hex chars of the sha256 of the file's contents.
 *
 * Returns `null` if `pkbRoot` does not exist (or is not a directory). This
 * is distinct from returning `[]` for a directory that exists but has no
 * `*.md` files — callers that run destructive reconciliation against the
 * result (e.g. `reconcilePkbIndex`) use the sentinel to avoid interpreting
 * a transiently missing directory as "delete every indexed point".
 */
export async function scanPkbFiles(
  pkbRoot: string,
): Promise<PkbIndexEntry[] | null> {
  const entries: PkbIndexEntry[] = [];

  // Verify the root exists up front. If it doesn't, return the missing
  // sentinel so callers can distinguish "nothing on disk" from "root
  // vanished". Other stat errors (permissions, etc.) fall through to the
  // recursive walk, which logs+swallows per-directory errors.
  try {
    const rootStat = await stat(pkbRoot);
    if (!rootStat.isDirectory()) {
      return null;
    }
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    // Non-ENOENT stat errors: treat as empty (same conservative behavior
    // the per-directory walk has). The destructive delete path is still
    // gated by the explicit missing-directory check above.
    return entries;
  }

  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      const absPath = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().endsWith(".md")) continue;

      let content: string;
      let mtimeMs: number;
      try {
        content = await readFile(absPath, "utf8");
        const st = await stat(absPath);
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }

      const contentHash = hashContent(content);
      const relPath = relative(pkbRoot, absPath);
      const chunks = chunkPkbFile(content);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        entries.push({
          path: relPath,
          mtimeMs,
          contentHash,
          chunkIndex,
        });
      }
    }
  }

  await walk(pkbRoot);
  return entries;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/**
 * Split markdown content into retrieval chunks.
 *
 * Strategy:
 *   - If the file is small (< WHOLE_FILE_THRESHOLD chars), return the whole
 *     file as a single chunk.
 *   - Otherwise split on lines starting with `## `, keeping each heading
 *     with the body of its section. Concatenation of the returned chunks is
 *     lossless — no content is dropped or duplicated.
 *   - If no `## ` headings are present, fall back to fixed-size character
 *     windows.
 */
export function chunkPkbFile(content: string): string[] {
  if (content.length < WHOLE_FILE_THRESHOLD) {
    return [content];
  }

  const headingIndices: number[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    // Find the next line that starts with "## " (either at the very beginning
    // of the file or immediately after a newline).
    const atStart = cursor === 0 && content.startsWith("## ");
    if (atStart) {
      headingIndices.push(0);
      cursor = 1; // advance past the match so the `indexOf` below keeps moving
      continue;
    }
    const nextNewline = content.indexOf("\n## ", cursor);
    if (nextNewline === -1) break;
    headingIndices.push(nextNewline + 1);
    cursor = nextNewline + 1;
  }

  if (headingIndices.length === 0) {
    // Fallback: fixed-size char windows.
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += CHAR_WINDOW_SIZE) {
      chunks.push(content.slice(i, i + CHAR_WINDOW_SIZE));
    }
    return chunks;
  }

  // Build chunks from heading boundaries. Preserve any preamble before the
  // first heading so concatenation stays lossless.
  const chunks: string[] = [];
  if (headingIndices[0] > 0) {
    chunks.push(content.slice(0, headingIndices[0]));
  }
  for (let i = 0; i < headingIndices.length; i++) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : content.length;
    chunks.push(content.slice(start, end));
  }
  return chunks;
}

/**
 * Read a PKB file, chunk it, and upsert each chunk to Qdrant via the shared
 * embedding pipeline. `relPath` in the payload is computed relative to
 * `pkbRoot`.
 *
 * Self-cleaning: deletes any previously-indexed chunks for this (scope, path)
 * before upserting the new ones. This keeps the index consistent when a file
 * shrinks — e.g. a prior run wrote chunks `#0..#3` and the new content only
 * produces `#0..#1`; without the pre-delete, `#2` and `#3` would linger as
 * orphaned stale results in search.
 */
export async function indexPkbFile(
  pkbRoot: string,
  absPath: string,
  memoryScopeId: string,
): Promise<void> {
  const content = await readFile(absPath, "utf8");
  const st = await stat(absPath);
  const mtimeMs = st.mtimeMs;
  const contentHash = hashContent(content);
  const relPath = relative(pkbRoot, absPath);
  const chunks = chunkPkbFile(content);

  const config = getConfig();

  await deletePkbFilePoints(relPath, memoryScopeId);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    // Scope-namespace the target_id so `qdrant.upsert` — which dedupes on
    // (target_type, target_id) — cannot collapse distinct scopes' chunks of
    // the same relpath into a single point. Without the scope prefix, the
    // second scope to index a shared path would overwrite the first's vectors.
    const targetId = `${memoryScopeId}:${relPath}#${chunkIndex}`;
    await embedAndUpsert(
      config,
      PKB_TARGET_TYPE,
      targetId,
      { type: "text", text: chunk },
      {
        path: relPath,
        mtime_ms: mtimeMs,
        chunk_index: chunkIndex,
        content_hash: contentHash,
        memory_scope_id: memoryScopeId,
      },
    );
  }
}

/**
 * Remove every Qdrant point belonging to a given PKB file (all chunks) within
 * a single memory scope. `relPath` must match the `path` payload written by
 * `indexPkbFile`. The `memoryScopeId` filter is required — omitting it would
 * wipe that relpath's chunks across every scope that indexes the same file.
 */
export async function deletePkbFilePoints(
  relPath: string,
  memoryScopeId: string,
): Promise<void> {
  const qdrant = getQdrantClient();
  await withQdrantBreaker(() =>
    qdrant.deleteByTargetTypeAndPath(PKB_TARGET_TYPE, relPath, memoryScopeId),
  );
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
