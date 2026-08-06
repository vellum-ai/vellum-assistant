import {
  isMemoryEnabled,
  isMemoryV3Live,
  isV2InjectionEngineActive,
} from "./memory-v3-gate.js";
import type { AssistantConfig } from "./schema.js";

export type MemoryTier = "off" | "v1" | "v2" | "v3";

/**
 * Derive the coarse memory tier for an assistant, as a single bucket for
 * telemetry. Precedence is defined by the named gate predicates in
 * `memory-v3-gate.ts` — this function is fully derived from them, so the tier
 * buckets and the runtime gates can never disagree:
 *
 * - `"off"` wins over everything: {@link isMemoryEnabled} is false when an
 *   explicit `memory.enabled === false` disables the whole memory system,
 *   regardless of v2/v3 settings.
 * - `"v3"` wins over `"v2"`: when memory-v3 is live it suppresses v2 injection
 *   (see {@link isMemoryV3Live}).
 * - `"v2"` when the v2 injection engine performs turn-time selection
 *   (see {@link isV2InjectionEngineActive}).
 * - `"v1"` otherwise (memory on, neither v2 nor v3 selected).
 */
export function memoryTier(config: AssistantConfig): MemoryTier {
  if (!isMemoryEnabled(config)) {
    return "off";
  }
  if (isMemoryV3Live(config)) {
    return "v3";
  }
  if (isV2InjectionEngineActive(config)) {
    return "v2";
  }
  return "v1";
}
