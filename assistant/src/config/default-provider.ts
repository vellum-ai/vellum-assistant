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

/**
 * Read `llm.defaultProvider` from config. Accepts an optional pre-loaded
 * config to stay pure (callers that already hold a config avoid a redundant
 * disk read); otherwise falls back to `getConfigReadOnly()`.
 *
 * No call-site resolution consumes this value; it is state for the default
 * inference identity (see `DefaultProviderSchema`).
 */
export function getDefaultProvider(
  config?: AssistantConfig,
): DefaultProviderConfig | null {
  const llm = (config ?? getConfigReadOnly()).llm;
  return llm.defaultProvider ?? null;
}

/**
 * Resolve the `provider_connections` row name a `DefaultProviderConfig`
 * points at, by convention:
 *
 * - An explicit `connectionName` always wins (including a dangling one — see
 *   `DefaultProviderSchema`'s docstring for why validating that here is out
 *   of scope).
 * - `vellum` resolves to the single managed connection.
 * - Every other provider resolves to its personal BYOK connection,
 *   `<provider>-personal`.
 *
 * Pure function — no I/O, no connection-existence check.
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

/**
 * Write `llm.defaultProvider` through the raw config (mirrors other config
 * writers, e.g. `sync-gated-profiles.ts`): validate the provider against the
 * schema enum, persist via `loadRawConfig`/`saveRawConfig`, and invalidate the
 * in-memory config cache so the next `getConfig()`/`getConfigReadOnly()` call
 * re-reads the write.
 */
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
