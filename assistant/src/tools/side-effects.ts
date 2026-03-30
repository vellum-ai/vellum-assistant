// Side-effect tool classification - single source of truth.
// Tools that modify state outside the assistant (filesystem writes,
// shell commands, network requests that trigger actions, etc.).
// Used by private-conversation gating and permission simulation to decide
// whether a tool invocation requires explicit approval.

const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_edit",
  "host_file_write",
  "host_file_edit",
  "bash",
  "host_bash",
  "web_fetch",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_scroll",
  "browser_select_option",
  "browser_hover",
  "browser_close",
  "browser_fill_credential",
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
