/**
 * Raw-config helper shared by the config PATCH and SET routes, the paths that
 * write a coding agent's model.
 */

import { isPlainObject } from "../util/object.js";

/**
 * Clearing a coding agent's model is a write of `null` - a PATCH of
 * `{ acp: { agents: { <id>: { model: null } } } }` or a
 * `config set acp.agents.<id>.model null`. The deep-merge assigns that literal
 * `null` because the stored value is a scalar, and a SET writes it verbatim by
 * design. The field is an optional string in `AcpConfigSchema`, so a persisted
 * `null` makes every later `loadConfig()` warn and take its salvage path,
 * dropping the whole `acp` section with the agents defined in it. Clearing
 * means removing the key, so drop it here on every write path.
 */
export function scrubNulledAcpModels(raw: Record<string, unknown>): void {
  const acp = raw.acp;
  if (!isPlainObject(acp)) {
    return;
  }
  const agents = acp.agents;
  if (!isPlainObject(agents)) {
    return;
  }
  for (const entry of Object.values(agents)) {
    if (isPlainObject(entry) && entry.model === null) {
      delete entry.model;
    }
  }
}
