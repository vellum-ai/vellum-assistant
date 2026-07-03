import { getConfig } from "../../../config/loader.js";
import type { MemoryConfig } from "../../../config/types.js";

/**
 * The `memory` slice of the live assistant config. Memory code reads its own
 * configuration through this accessor rather than the full `getConfig()`, so its
 * config dependency is a narrow slice of `AssistantConfig`.
 */
export function getMemoryConfig(): MemoryConfig {
  return getConfig().memory;
}
