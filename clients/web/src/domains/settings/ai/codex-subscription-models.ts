import { getModelsForProvider } from "@/assistant/llm-model-catalog";
import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// Keep in sync with CODEX_SUBSCRIPTION_MODEL_IDS in
// assistant/src/providers/openai/codex-models.ts.
export const CODEX_SUBSCRIPTION_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  // OpenAI retires these two from ChatGPT sign-in on 2026-08-31; API-key
  // auth is unaffected.
  "gpt-5.4",
  "gpt-5.4-mini",
]);

/** The provider's catalog models a ChatGPT subscription can dispatch. */
export function codexServableModels(
  provider: ConnectionProvider,
): ReturnType<typeof getModelsForProvider> {
  return getModelsForProvider(provider).filter((m) =>
    CODEX_SUBSCRIPTION_MODEL_IDS.has(m.id),
  );
}

/**
 * Whether a connection restricts a catalog-backed provider to the
 * Codex-compatible subscription model set. A ChatGPT `oauth_subscription`
 * connection hard-routes to the Codex endpoint, which rejects any model
 * outside the set with HTTP 400, so every surface that offers models for
 * such a connection must respect the limit.
 */
export function restrictsToSubscriptionModels(
  provider: ConnectionProvider | "",
  providerConnection: string,
  availableConnectionsForProvider: ProviderConnection[],
): boolean {
  if (!provider || getModelsForProvider(provider).length === 0) {
    return false;
  }
  const selectedConn = providerConnection
    ? availableConnectionsForProvider.find((c) => c.name === providerConnection)
    : undefined;
  if (selectedConn?.auth.type === "oauth_subscription") {
    return true;
  }
  return (
    !providerConnection &&
    availableConnectionsForProvider.length > 0 &&
    availableConnectionsForProvider.every(
      (c) => c.auth.type === "oauth_subscription",
    )
  );
}
