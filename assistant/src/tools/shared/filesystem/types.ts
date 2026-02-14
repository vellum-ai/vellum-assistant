/**
 * Shared input/output contracts for filesystem tools (read, write, edit).
 *
 * These types define the normalized shape of tool inputs after validation
 * and the structured results returned by the shared operation layer.
 * Both sandbox and host filesystem tools will converge on these contracts.
 */

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface FileReadInput {
  /** Resolved absolute path to the file. */
  path: string;
  /** 1-indexed line number to start reading from (default: 1). */
  offset?: number;
  /** Maximum number of lines to return. */
  limit?: number;
}

export interface FileReadOutput {
  /** The file content (may be line-numbered depending on the caller). */
  content: string;
  /** Total number of lines in the file. */
  totalLines: number;
  /** 1-indexed start line of the returned window. */
  startLine: number;
  /** Number of lines returned. */
  linesReturned: number;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface FileWriteInput {
  /** Resolved absolute path to the file. */
  path: string;
  /** The content to write. */
  content: string;
}

export interface FileWriteOutput {
  /** The resolved path that was written to. */
  path: string;
  /** Whether the file was newly created (vs. overwritten). */
  created: boolean;
  /** Number of bytes written. */
  bytesWritten: number;
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface FileEditInput {
  /** Resolved absolute path to the file. */
  path: string;
  /** The exact text to find in the file. */
  oldString: string;
  /** The replacement text. */
  newString: string;
  /** Replace all occurrences instead of requiring a unique match. */
  replaceAll?: boolean;
}

export interface FileEditOutput {
  /** The resolved path that was edited. */
  path: string;
  /** Number of replacements made. */
  replacements: number;
  /** How the match was found (exact, whitespace-normalized, or fuzzy). */
  matchMethod: 'exact' | 'whitespace' | 'fuzzy';
  /** Similarity score for fuzzy matches (1.0 for exact/whitespace). */
  similarity: number;
}
