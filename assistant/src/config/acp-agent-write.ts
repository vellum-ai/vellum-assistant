/**
 * Raw-config helper shared by the config PATCH and SET routes, the paths that
 * write a coding agent's entry.
 */

import { isPlainObject } from "../util/object.js";

/**
 * Clearing a leaf of a coding agent's entry is a write of `null` - a PATCH of
 * `{ acp: { agents: { <id>: { model: null } } } }` or a
 * `config set acp.agents.<id>.model null`. The deep-merge assigns that literal
 * `null` because the stored value is a scalar, and a SET writes it verbatim by
 * design. Both `command` and `model` are optional strings in `AcpConfigSchema`,
 * so a persisted `null` makes every later `loadConfig()` warn and take its
 * salvage path, dropping the whole `acp` section with the agents defined in it.
 * Clearing means removing the key, so drop it here on every write path.
 *
 * A cleared `command` then reads as an omitted one: a bundled id inherits the
 * profile's command, and an id that has no profile fails the agents refinement
 * with a message naming the id, which tells the user more than zod's "expected
 * string, received null".
 */
export function scrubNulledAcpAgentLeaves(raw: Record<string, unknown>): void {
  const acp = raw.acp;
  if (!isPlainObject(acp)) {
    return;
  }
  const agents = acp.agents;
  if (!isPlainObject(agents)) {
    return;
  }
  for (const entry of Object.values(agents)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    if (entry.command === null) {
      delete entry.command;
    }
    if (entry.model === null) {
      delete entry.model;
    }
  }
}
