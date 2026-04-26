/**
 * Trust rule types shared between the assistant daemon and the gateway.
 *
 * These are extracted from `assistant/src/permissions/types.ts` and
 * `assistant/src/permissions/trust-store.ts` so that both packages can
 * reference a single canonical definition.
 *
 * Tools are grouped into "families" based on how their permission candidates
 * are constructed and matched:
 *
 * - **Scoped**: tools whose candidates include a filesystem path and obey
 *   directory-boundary scope constraints (`file_read`, `file_write`,
 *   `file_edit`, `host_file_read`, `host_file_write`, `host_file_edit`,
 *   `host_file_transfer`, `bash`, `host_bash`).
 * - **URL**: tools whose candidates include a URL (`web_fetch`,
 *   `network_request`).
 * - **Managed skill**: tools that manage first-party skill packages
 *   (`scaffold_managed_skill`, `delete_managed_skill`).
 * - **Skill load**: the `skill_load` tool, which uses a distinct candidate
 *   namespace (`skill_load:selector` or `skill_load_dynamic:selector`).
 * - **Generic**: everything else (computer-use tools, UI surface tools,
 *   recall, skill_execute, etc.).
 */

// ---------------------------------------------------------------------------
// Trust decision
// ---------------------------------------------------------------------------

/** The possible decisions a trust rule can make. */
export type TrustDecision = "allow" | "deny" | "ask";

// ---------------------------------------------------------------------------
// Tool family constants
// ---------------------------------------------------------------------------

/**
 * Tools whose permission candidates are scoped to a filesystem path and obey
 * directory-boundary scope constraints.
 */
export const SCOPED_TOOLS = [
  "file_read",
  "file_write",
  "file_edit",
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_file_transfer",
  "bash",
  "host_bash",
] as const;

/**
 * Tools whose permission candidates include a URL.
 */
export const URL_TOOLS = ["web_fetch", "network_request"] as const;

/**
 * Tools that manage first-party skill packages (scaffold/delete).
 */
export const MANAGED_SKILL_TOOLS = [
  "scaffold_managed_skill",
  "delete_managed_skill",
] as const;

/**
 * The skill_load tool name. Separated from the array constants because
 * skill_load is a singleton, not a family with multiple members.
 */
export const SKILL_LOAD_TOOL = "skill_load" as const;

/** Set for O(1) lookups when classifying tool names. */
const SCOPED_TOOLS_SET: ReadonlySet<string> = new Set(SCOPED_TOOLS);
const URL_TOOLS_SET: ReadonlySet<string> = new Set(URL_TOOLS);
const MANAGED_SKILL_TOOLS_SET: ReadonlySet<string> = new Set(
  MANAGED_SKILL_TOOLS,
);

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true when the rule's tool belongs to the scoped-tool family. */
export function isScopedRule(rule: { tool: string }): boolean {
  return SCOPED_TOOLS_SET.has(rule.tool);
}

/** Returns true when the rule's tool belongs to the URL-tool family. */
export function isUrlRule(rule: { tool: string }): boolean {
  return URL_TOOLS_SET.has(rule.tool);
}

/** Returns true when the rule's tool belongs to the managed-skill-tool family. */
export function isManagedSkillRule(rule: { tool: string }): boolean {
  return MANAGED_SKILL_TOOLS_SET.has(rule.tool);
}

/** Returns true when the rule's tool is the skill_load tool. */
export function isSkillLoadRule(rule: { tool: string }): boolean {
  return rule.tool === SKILL_LOAD_TOOL;
}

// ---------------------------------------------------------------------------
// Scope helper
// ---------------------------------------------------------------------------

/**
 * Return the effective scope for any trust rule. Only scoped rules carry a
 * `scope` field; all other rule families return `"everywhere"`.
 */
export function ruleScope(rule: { tool: string; scope?: string }): string {
  if (isScopedRule(rule)) {
    return rule.scope ?? "everywhere";
  }
  return "everywhere";
}

