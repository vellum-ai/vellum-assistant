/**
 * Pure resolution of `memory.provider` to a concrete {@link MemoryProviderId}.
 *
 * Kept dependency-free (config types only) and separate from `resolve.ts` so
 * the v3 injector — which the v3 provider imports — can read the active
 * provider id without dragging the provider implementations back through that
 * import cycle.
 */

import type { AssistantConfig } from "../../config/schema.js";
import type { MemoryProviderId } from "./types.js";

/**
 * Resolve `memory.provider` to a concrete provider id, expanding the `"auto"`
 * sentinel to the `v2.enabled`/`v3.live`-derived selection: v3 when v3 is live,
 * else v2 when enabled, else the graph system. A call site that gates on v3
 * being the live system checks `resolveMemoryProviderId(config) === "v3"`;
 * under `"auto"` this matches the `v3.live` flag exactly, and it extends
 * cleanly to an explicit `memory.provider` setting.
 */
export function resolveMemoryProviderId(
  config: AssistantConfig,
): MemoryProviderId {
  const requested = config.memory?.provider ?? "auto";
  if (requested !== "auto") {
    return requested;
  }
  if (config.memory?.v3?.live === true) {
    return "v3";
  }
  if (config.memory?.v2?.enabled === true) {
    return "v2";
  }
  return "graph";
}
