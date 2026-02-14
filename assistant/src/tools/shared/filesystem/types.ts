// Shared input/output contracts for filesystem operations.
// Used by both sandbox and host filesystem tools.

// ── Read ────────────────────────────────────────────────

export interface FileReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface FileReadOutput {
  content: string;
}

// ── Write ───────────────────────────────────────────────

export interface FileWriteInput {
  path: string;
  content: string;
}

export interface FileWriteOutput {
  filePath: string;
}

// ── Edit ────────────────────────────────────────────────

export interface FileEditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileEditOutput {
  filePath: string;
  replacementCount: number;
  matchMethod: 'exact' | 'whitespace' | 'fuzzy';
}
