// Side-effect tool classification - single source of truth.
// Tools that modify state outside the assistant (filesystem writes,
// shell commands, network requests that trigger actions, etc.).
// Used by private-conversation gating and permission simulation to decide
// whether a tool invocation requires explicit approval.

import { BROWSER_TOOL_NAMES } from "../browser/operations.js";

/**
 * Browser tools that are read-only / observational and do NOT have
 * side effects. These are excluded from the side-effect set.
 * The mutating browser tools (navigate, click, type, etc.) are derived
 * from BROWSER_TOOL_NAMES by subtracting this set.
 */
const BROWSER_READONLY_TOOLS = new Set([
  "browser_snapshot",
  "browser_screenshot",
  "browser_extract",
  "browser_wait_for",
  "browser_wait_for_download",
  "browser_status",
]);

const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_edit",
  "host_file_write",
  "host_file_edit",
  "bash",
  "host_bash",
  "web_fetch",
  ...BROWSER_TOOL_NAMES.filter((name) => !BROWSER_READONLY_TOOLS.has(name)),
  "document_create",
  "document_update",
  "schedule_create",
  "schedule_update",
  "schedule_delete",
  "manage_secure_command_tool",
]);

/**
 * Returns `true` if the given tool name is classified as having side effects
 * (i.e. it can modify the filesystem, execute arbitrary commands, or trigger
 * external actions). Read-only and informational tools return `false`.
 *
 * For mixed-action tools (e.g. credential_store), the optional
 * `input` parameter is inspected to distinguish mutating actions (create,
 * update, cancel) from read-only ones (list, get).
 */
export function isSideEffectTool(
  toolName: string,
  input?: Record<string, unknown>,
): boolean {
  if (SIDE_EFFECT_TOOLS.has(toolName)) return true;

  // Action-aware checks for mixed-action tools
  if (toolName === "credential_store") {
    const action = input?.action;
    return action === "store" || action === "delete" || action === "prompt";
  }

  return false;
}
