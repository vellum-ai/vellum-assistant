import { isMemoryV3Live } from "./memory-v3-gate.js";
import type { AssistantConfig } from "./schema.js";

export type MemoryTier = "off" | "v1" | "v2" | "v3";

/**
 * Derive the coarse memory tier for an assistant, as a single bucket for
 * telemetry. Precedence mirrors the runtime memory-source semantics:
 *
 * - `"off"` wins over everything: an explicit `memory.enabled === false`
 *   disables the whole memory system regardless of v2/v3 settings.
 * - `"v3"` wins over `"v2"`: when memory-v3 is live it suppresses v2 injection
 *   (see {@link isMemoryV3Live}).
 * - `"v2"` when v2 is explicitly enabled and v3 is not live.
 * - `"v1"` otherwise (memory on, neither v2 nor v3 selected).
 *
 * Optional chaining is defensive — a partial config (e.g. a mocked config in
 * tests) resolves to the correct bucket rather than throwing.
 */
export function memoryTier(config: AssistantConfig): MemoryTier {
  if (config.memory?.enabled === false) {
    return "off";
  }
  if (isMemoryV3Live(config)) {
    return "v3";
  }
  if (config.memory?.v2?.enabled === true) {
    return "v2";
  }
  return "v1";
}
