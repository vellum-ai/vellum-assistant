/**
 * Resolve the active memory system from `memory.provider`.
 *
 * Maps the `memory.provider` selector onto a single {@link MemoryProvider}:
 * `"graph"`/`"v2"`/`"v3"`/`"none"` pin a specific system, and `"auto"`
 * reproduces the legacy selection derived from `memory.v2.enabled` and
 * `memory.v3.live` — when v3 is live it wins, otherwise v2 if enabled, else the
 * graph system. The graph/v2/v3 providers register into a process-wide
 * {@link MemoryProviderRegistry} once; daemon core selects the active memory
 * system through this module.
 */

import type { AssistantConfig } from "../../config/schema.js";
import { GraphMemoryProvider } from "./graph-provider.js";
import { resolveMemoryProviderId } from "./provider-id.js";
import { MemoryProviderRegistry, NullMemoryProvider } from "./registry.js";
import type { MemoryProvider } from "./types.js";
import { V2MemoryProvider } from "./v2-provider.js";
import { V3MemoryProvider } from "./v3-provider.js";

export { resolveMemoryProviderId } from "./provider-id.js";

let registry: MemoryProviderRegistry | null = null;

/**
 * Lazily build the process-wide registry with the graph/v2/v3 providers
 * registered. Idempotent: the registry is constructed once and reused.
 */
function getRegistry(): MemoryProviderRegistry {
  if (registry) return registry;
  const next = new MemoryProviderRegistry();
  next.register("graph", () => GraphMemoryProvider);
  next.register("v2", () => V2MemoryProvider);
  next.register("v3", () => V3MemoryProvider);
  registry = next;
  return registry;
}

/**
 * Resolve the active {@link MemoryProvider} for the given config. Falls back to
 * a {@link NullMemoryProvider} only for `"none"` (or an unregistered id), which
 * contributes no injection, tools, or post-turn work.
 */
export function resolveMemoryProvider(config: AssistantConfig): MemoryProvider {
  const id = resolveMemoryProviderId(config);
  if (id === "none") {
    return new NullMemoryProvider();
  }
  return getRegistry().resolve({ ...config.memory, provider: id });
}
