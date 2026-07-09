/**
 * Pure default-provider read helpers — no `config/loader` imports, by design.
 * Route handlers (and their tests, which often partially mock the loader)
 * import from here so that pulling default-provider logic into a module graph
 * never drags write-side loader exports along with it. Loader-coupled
 * conveniences (`getDefaultProvider()` without an argument,
 * `setDefaultProvider`) live in `default-provider.ts`.
 */
import { VELLUM_MANAGED_CONNECTION_NAME } from "../providers/vellum-model-routing.js";
import type { DefaultProviderConfig } from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

export function getDefaultProviderFromConfig(
  config: AssistantConfig,
): DefaultProviderConfig | null {
  return config.llm.defaultProvider ?? null;
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
