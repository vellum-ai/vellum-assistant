/**
 * Lightweight browser identifier helpers.
 *
 * Exports browser tool-name constants and bidirectional name-mapping
 * functions without importing any runtime browser dependencies
 * (browser-execution, browser-manager, browser-mode).
 */

import { BROWSER_OPERATIONS, type BrowserOperation } from "./types.js";

// ── Tool name constants ──────────────────────────────────────────────

/**
 * All `browser_*` tool names derived from operation identifiers.
 *
 * Maps each operation in {@link BROWSER_OPERATIONS} to its `browser_`
 * prefixed tool name for use in legacy compatibility paths.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_OPERATIONS.map(
  (op) => `browser_${op}`,
);

// ── Bidirectional name mapping ───────────────────────────────────────

/**
 * Convert a `browser_*` tool name to its canonical operation ID.
 * Returns `undefined` if the tool name does not match a known operation.
 */
export function browserToolNameToOperation(
  toolName: string,
): BrowserOperation | undefined {
  if (!toolName.startsWith("browser_")) return undefined;
  const candidate = toolName.slice("browser_".length);
  if ((BROWSER_OPERATIONS as readonly string[]).includes(candidate)) {
    return candidate as BrowserOperation;
  }
  return undefined;
}

/**
 * Convert a canonical operation ID to its `browser_*` tool name.
 * Returns `undefined` if the operation is not a known identifier.
 */
export function browserOperationToToolName(
  operation: string,
): string | undefined {
  if ((BROWSER_OPERATIONS as readonly string[]).includes(operation)) {
    return `browser_${operation}`;
  }
  return undefined;
}
