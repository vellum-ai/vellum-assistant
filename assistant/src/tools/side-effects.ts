// Side-effect tool classification - single source of truth.
// Tools that modify state outside the assistant (filesystem writes,
// shell commands, network requests that trigger actions, etc.).
// Used by permission simulation and forced approval paths to decide whether
// a tool invocation requires explicit approval.

const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_edit",
  "host_file_write",
  "host_file_edit",
  "bash",
  "host_bash",
  "web_fetch",
  "document_create",
  "document_update",
  "document_delete",
  "schedule_create",
  "schedule_update",
  "schedule_delete",
]);

/**
 * Returns `true` if the given tool name is classified as having side effects
 * (i.e. it can modify the filesystem, execute arbitrary commands, or trigger
 * external actions). Read-only and informational tools return `false`.
 */
export function isSideEffectTool(toolName: string): boolean {
  return SIDE_EFFECT_TOOLS.has(toolName);
}
