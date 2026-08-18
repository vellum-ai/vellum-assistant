import {
  CODEX_SUBSCRIPTION_MODEL_IDS,
  getModelsForProvider,
} from "@/assistant/llm-model-catalog";
import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

export { CODEX_SUBSCRIPTION_MODEL_IDS };

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
 *
 * This matters only for the pre-migration-366 row shape, where daemons
 * older than the identity work return the subscription row as provider
 * "openai" and openai fragments auto-resolve onto it. Daemons past 366
 * return the row as provider "chatgpt", exact-match filtering keeps it out
 * of openai candidate lists, and the chatgpt picker entry carries the
 * Codex-only model list itself.
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
