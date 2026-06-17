import type { AssistantConfig } from "./schema.js";

/**
 * Whether memory-v3 is the live injected memory source for this assistant,
 * suppressing v2 injection. Gated by workspace config (`memory.v3.live`): new
 * assistants are switched on at creation via a workspace migration, while
 * existing assistants stay on v2 until the value is set explicitly.
 */
export function isMemoryV3Live(config: AssistantConfig): boolean {
  return config.memory.v3.live === true;
}
