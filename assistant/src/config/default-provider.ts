import { VELLUM_MANAGED_CONNECTION_NAME } from "../providers/vellum-model-routing.js";
import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import type { DefaultProviderConfig } from "./schemas/llm.js";
import { DefaultProviderSchema } from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

export function getDefaultProvider(
  config?: AssistantConfig,
): DefaultProviderConfig | null {
  const llm = (config ?? getConfigReadOnly()).llm;
  return llm.defaultProvider ?? null;
}

/**
 * Pure by design — no connection-existence check. A dangling name (explicit
 * or conventional) is allowed; see `DefaultProviderSchema`.
 */
export function resolveDefaultConnectionName(
  dp: DefaultProviderConfig,
): string {
  if (dp.connectionName) {
    return dp.connectionName;
  }
  if (dp.provider === "vellum") {
    return VELLUM_MANAGED_CONNECTION_NAME;
  }
  return `${dp.provider}-personal`;
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
