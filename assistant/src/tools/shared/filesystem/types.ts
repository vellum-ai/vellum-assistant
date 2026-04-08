import type { FsError } from "./errors.js";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ReadInput {
  path: string;
  /** 1-indexed line number to start reading from. */
  offset?: number;
  /** Maximum number of lines to read. */
  limit?: number;
}

export interface ReadOutput {
  /** The (possibly line-numbered) file content. */
  content: string;
}

export type ReadResult =
  | { ok: true; value: ReadOutput }
  | { ok: false; error: FsError };

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface WriteInput {
  path: string;
  content: string;
}

export interface WriteOutput {
  /** Absolute path that was written to. */
  filePath: string;
  /** True when the file did not exist before this write. */
  isNewFile: boolean;
  /** Previous content (empty string for new files or unreadable files). */
  oldContent: string;
  /** The content that was written. */
  newContent: string;
}

export type WriteResult =
  | { ok: true; value: WriteOutput }
  | { ok: false; error: FsError };

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface EditOutput {
  /** Absolute path that was edited. */
  filePath: string;
  /** Number of replacements made. */
  matchCount: number;
  /** File content before the edit. */
  oldContent: string;
  /** File content after the edit. */
  newContent: string;
  /** How the match was found (exact, whitespace-normalized, or fuzzy). */
  matchMethod: "exact" | "whitespace" | "fuzzy";
  /** Match similarity score (0–1). Always 1 for exact/whitespace, <1 for fuzzy. */
  similarity: number;
  /** The text that was actually matched in the file (may differ from the requested old_string for fuzzy/whitespace matches). */
  actualOld: string;
  /** The replacement text actually written (may have adjusted indentation for non-exact matches). */
  actualNew: string;
}

export type EditResult =
  | { ok: true; value: EditOutput }
  | { ok: false; error: FsError };

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListInput {
  path: string;
  glob?: string;
}

export interface ListOutput {
  listing: string;
}

export type ListResult =
  | { ok: true; value: ListOutput }
  | { ok: false; error: FsError };
