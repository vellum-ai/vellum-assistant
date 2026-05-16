/**
 * Feature-flag-aware provider catalog filtering.
 *
 * User-facing catalog consumers (model info, slash commands, provider
 * availability) use `getVisibleProviderCatalog()` to hide providers and
 * models gated behind disabled feature flags. Internal consumers
 * (adapter-factory, pricing, auth) continue using the unfiltered
 * `PROVIDER_CATALOG` directly.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from "./model-catalog.js";

export function getVisibleProviderCatalog(
  config: AssistantConfig,
): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter(
    (entry) =>
      !entry.featureFlag ||
      isAssistantFeatureFlagEnabled(entry.featureFlag, config),
  )
    .map((entry) => {
      const visibleModels = entry.models.filter(
        (m) =>
          !m.featureFlag ||
          isAssistantFeatureFlagEnabled(m.featureFlag, config),
      );
      if (visibleModels.length === entry.models.length) return entry;
      return { ...entry, models: visibleModels };
    })
    .filter(
      (entry) => entry.models.length > 0 || entry.defaultModel === "",
    );
}
