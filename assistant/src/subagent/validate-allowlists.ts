/**
 * Boot-time validation that every tool named in a subagent role's allowlist
 * resolves to a real registered tool.
 *
 * A role allowlist (`SUBAGENT_ROLE_REGISTRY[role].allowedTools` in ./types.ts)
 * is a list of plain tool-name strings. The names are matched against the live
 * tool set purely by string equality (`subagentAllowedTools.has(name)`), so if
 * a tool is renamed in the registry without updating the allowlist, the role
 * silently loses access to it — the stale name simply never matches anything.
 * This check surfaces that drift as a startup warning instead of a silent
 * capability gap.
 */

import { getAllTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { SUBAGENT_ROLE_REGISTRY } from "./types.js";

const log = getLogger("subagent-allowlist");

/** A role allowlist entry that has no matching registered tool. */
export interface UnknownAllowlistTool {
  role: string;
  tool: string;
}

/**
 * Pure core: given the set of registered tool names, return every allowlist
 * entry that has no matching registered tool. Roles with no allowlist
 * (`allowedTools: undefined`, e.g. `general`) impose no filter and contribute
 * nothing. Exported for direct unit testing without standing up the real tool
 * registry.
 */
export function findUnknownAllowlistTools(
  registeredToolNames: ReadonlySet<string>,
): UnknownAllowlistTool[] {
  const unknown: UnknownAllowlistTool[] = [];
  for (const [role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
    if (!config.allowedTools) continue;
    for (const tool of config.allowedTools) {
      if (!registeredToolNames.has(tool)) unknown.push({ role, tool });
    }
  }
  return unknown;
}

/**
 * Validate every subagent role allowlist against the live tool registry,
 * logging a warning for each unknown tool name. Uses `getAllTools()` — the raw
 * registry, including tools owned by disabled plugins — rather than
 * `getEnabledTools()`, so a legitimately-disabled plugin does not produce a
 * false-positive warning: we are checking that the *name* exists, not that the
 * tool is currently enabled. Never throws; returns the list of unknown
 * `${role}:${tool}` entries (empty when every allowlist entry resolves).
 */
export function validateSubagentRoleAllowlists(): string[] {
  const registered = new Set(getAllTools().map((tool) => tool.name));
  const unknown = findUnknownAllowlistTools(registered);
  for (const { role, tool } of unknown) {
    log.warn(
      { role, tool },
      "Subagent role allowlist references unknown tool — role will silently lack access to it",
    );
  }
  return unknown.map(({ role, tool }) => `${role}:${tool}`);
}
