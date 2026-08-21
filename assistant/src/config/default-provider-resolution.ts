/**
 * Pure default-provider read helpers — no `config/loader` imports, by design.
 * Route handlers (and their tests, which often partially mock the loader)
 * import from here so that pulling default-provider logic into a module graph
 * never drags write-side loader exports along with it. Loader-coupled
 * conveniences (`getDefaultProvider()` without an argument,
 * `setDefaultProvider`) live in `default-provider.ts`.
 */
import { CHATGPT_SUBSCRIPTION_CONNECTION_NAME } from "../providers/inference/auth.js";
import { VELLUM_MANAGED_CONNECTION_NAME } from "../providers/vellum-model-routing.js";
import type { DefaultProviderConfig } from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

export function getDefaultProviderFromConfig(
  config: AssistantConfig,
): DefaultProviderConfig | null {
  return config.llm.defaultProvider ?? null;
}

/**
 * Pure by design — no connection-existence check. A dangling conventional
 * name is allowed; see `DefaultProviderSchema`.
 *
 * The single home of the conventional-row naming: identities resolve to
 * their canonical rows, catalog vendors to `<provider>-personal`. Accepts
 * any provider value (not just `DefaultProviderConfig`'s enum) so
 * connection auto-resolution can prefer the same row the default-provider
 * status route and the deletion guard report.
 */
export function resolveDefaultConnectionName(dp: { provider: string }): string {
  if (dp.provider === "vellum") {
    return VELLUM_MANAGED_CONNECTION_NAME;
  }
  if (dp.provider === "chatgpt") {
    return CHATGPT_SUBSCRIPTION_CONNECTION_NAME;
  }
  return `${dp.provider}-personal`;
}
