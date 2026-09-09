/**
 * Raw-config helper shared by every path that writes a coding-agent model:
 * the config PATCH and SET routes and the `acp_set_default_model` tool.
 */

import { isPlainObject } from "../util/object.js";

/**
 * Clearing a coding-agent model is a write of `null` - a PATCH of
 * `{ acp: { defaultModel: null } }`, a `config set acp.defaultModel null`, or
 * either shape aimed at `acp.agents.<id>.model`. The deep-merge assigns that
 * literal `null` because the stored value is a scalar, and a SET writes it
 * verbatim by design. Both model fields are optional strings in
 * `AcpConfigSchema`, so a persisted `null` makes every later `loadConfig()`
 * warn and take its salvage path, dropping the whole `acp` section with the
 * agents defined in it. Clearing means removing the key, so drop it here on
 * every write path.
 */
export function scrubNulledAcpModels(raw: Record<string, unknown>): void {
  const acp = raw.acp;
  if (!isPlainObject(acp)) {
    return;
  }
  if (acp.defaultModel === null) {
    delete acp.defaultModel;
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
