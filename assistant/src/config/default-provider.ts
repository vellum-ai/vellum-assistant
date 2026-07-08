/**
 * Loader-coupled default-provider accessors. The pure read/resolution logic
 * lives in `default-provider-resolution.ts`; import from there in code that
 * already has a config in hand (route handlers especially) so the module
 * graph stays free of write-side loader exports.
 */
import { getDefaultProviderFromConfig } from "./default-provider-resolution.js";
import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import type { DefaultProviderConfig } from "./schemas/llm.js";
import { DefaultProviderSchema } from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

export { resolveDefaultConnectionName } from "./default-provider-resolution.js";

export function getDefaultProvider(
  config?: AssistantConfig,
): DefaultProviderConfig | null {
  return getDefaultProviderFromConfig(config ?? getConfigReadOnly());
}

export function setDefaultProvider(value: DefaultProviderConfig): void {
  const parsed = DefaultProviderSchema.parse(value);

  const config = loadRawConfig();
  if (config.llm == null || typeof config.llm !== "object") {
    config.llm = {};
  }
  const llm = config.llm as Record<string, unknown>;
  llm.defaultProvider = parsed;

  saveRawConfig(config);
  invalidateConfigCache();
}
