/**
 * Canonical browser operation identifiers and typed metadata.
 *
 * This module defines the shared vocabulary for browser operations,
 * independent of skill-tool registration or TOOLS.json. Both the
 * tool wrappers and the CLI command builder consume these types.
 */

// ── Operation identifiers ────────────────────────────────────────────

/**
 * Canonical operation identifiers for every browser operation.
 * Each maps 1:1 to a `browser_*` tool name via deterministic
 * naming convention (`navigate` <-> `browser_navigate`).
 */
export const BROWSER_OPERATIONS = [
  "navigate",
  "snapshot",
  "screenshot",
  "close",
  "attach",
  "detach",
  "click",
  "type",
  "press_key",
  "scroll",
  "select_option",
  "hover",
  "wait_for",
  "extract",
  "wait_for_download",
  "fill_credential",
  "status",
] as const;

export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

// ── Field metadata types ─────────────────────────────────────────────

/** Scalar types that operation fields can have. */
export type OperationFieldType = "string" | "number" | "boolean";

/** Metadata for a single field on an operation. */
export interface OperationField {
  /** The field name as it appears in the input object. */
  name: string;
  /** The scalar type of the field. */
  type: OperationFieldType;
  /** Human-readable description for CLI help text. */
  description: string;
  /** Whether this field is required for the operation. */
  required: boolean;
  /** For string enums, the allowed values. */
  enum?: readonly string[];
}

/**
 * Command-oriented metadata for a single browser operation.
 * Used by the CLI command builder to generate subcommands
 * without reading TOOLS.json.
 */
export interface BrowserOperationMeta {
  /** The canonical operation identifier. */
  operation: BrowserOperation;
  /** Human-readable summary for CLI help text. */
  description: string;
  /** Ordered list of fields (required first, then optional). */
  fields: readonly OperationField[];
  /**
   * When set, the operation is restricted to these browser_mode
   * values. For example, `wait_for_download` only supports
   * `["auto", "local"]`.
   */
  allowedModes?: readonly string[];
  /**
   * Extended help text appended after the auto-generated options list.
   * Should include behavioral notes and 2-3 concrete examples per
   * CLI AGENTS.md Help Text Standards.
   */
  helpText?: string;
}
