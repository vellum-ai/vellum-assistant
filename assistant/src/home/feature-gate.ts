import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

const HOME_PAGE_FLAG_KEY = "home-page" as const;

/**
 * Whether the home page / home feed surface is enabled for this install.
 *
 * `home-page` is a `"both"`-scope flag: the client renders the home feed as the
 * landing view, and the notification pipeline uses it to decide whether passive
 * notifications have a home-feed surface to land on (when off, they fall back to
 * materializing a conversation instead of being suppressed).
 *
 * `config` is accepted for parity with the other gate modules but is unused —
 * the value resolves from the gateway override cache / registry default.
 */
export function isHomePageEnabled(config?: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(
    HOME_PAGE_FLAG_KEY,
    (config ?? {}) as AssistantConfig,
  );
}
