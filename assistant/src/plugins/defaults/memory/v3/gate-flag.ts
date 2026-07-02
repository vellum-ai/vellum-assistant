import { isAssistantFeatureFlagEnabled } from "../../../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../../../config/schema.js";

/** Feature-flag id (kebab-case) gating the memory-v3 per-turn injection gate. */
export const MEMORY_V3_INJECTION_GATE_FLAG =
  "memory-v3-injection-gate" as const;

/** Whether the memory-v3 injection gate is enabled for this config: the
 *  feature flag (resolved via the standard assistant flag resolver — gateway
 *  override → registry default → false) AND the `memory.v3.gate.enabled`
 *  config kill-switch. `enabled: false` forces the full selection process
 *  every turn even with the flag on. Thresholds live in `memory.v3.gate`. */
export function isMemoryV3InjectionGateEnabled(
  config: AssistantConfig,
): boolean {
  return (
    isAssistantFeatureFlagEnabled(MEMORY_V3_INJECTION_GATE_FLAG, config) &&
    config.memory.v3.gate.enabled
  );
}
