/**
 * Lightweight browser identifier helpers.
 *
 * This module exports browser tool-name constants and bidirectional
 * name-mapping functions without importing any runtime browser
 * dependencies (browser-execution, browser-manager, browser-mode).
 *
 * Policy and classification modules (permissions/defaults,
 * workspace-policy, side-effects) should import from here instead
 * of from `operations.ts` to avoid pulling the browser execution
 * stack into non-browser codepaths.
 */

import { BROWSER_OPERATIONS, type BrowserOperation } from "./types.js";

// ── Tool name constants ──────────────────────────────────────────────

/**
 * All `browser_*` tool names derived from operation identifiers.
 *
 * These names are the LLM-facing tool aliases registered by the browser
 * skill wrappers. They are compatibility adapters: the canonical
 * identifiers are the operation names in {@link BROWSER_OPERATIONS},
 * and the `browser_*` prefix is a naming convention for the tool layer.
 *
 * Consumed by:
 *   - Permission default rules (permissions/defaults.ts)
 *   - Workspace policy classification (permissions/workspace-policy.ts)
 *   - Side-effect tool classification (tools/side-effects.ts)
 *   - Test harnesses and parity guards
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
