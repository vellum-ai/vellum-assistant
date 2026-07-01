import { getConfig } from "../../../config/loader.js";
import type { MemoryConfig } from "../../../config/types.js";

/**
 * The memory slice of the assistant config. Memory reads its own configuration
 * through this accessor rather than the full `getConfig()`, so the plugin's
 * config dependency is a narrow slice — the shape a future `@vellumai/plugin-api`
 * accessor would expose — instead of the whole `AssistantConfig`. Reads that
 * genuinely need cross-cutting config (e.g. embeddings backend, MCP) still call
 * `getConfig()` directly; those are the residual to resolve before the slice can
 * be blessed.
 */
export function getMemoryConfig(): MemoryConfig {
  return getConfig().memory;
}
