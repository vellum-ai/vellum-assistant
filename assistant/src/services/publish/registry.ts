/**
 * Publish provider selection and the credential wrapper every publish path
 * goes through.
 *
 * `apps.publish.provider` names the provider; an id the config schema could
 * not keep has already fallen back to the shipped default by the time it is
 * read here, so selection never fails.
 */

import { getConfig } from "../../config/loader.js";
import type { PublishProviderId } from "../../config/schemas/apps.js";
import { credentialBroker } from "../../tools/credentials/broker.js";
import { getCredentialMetadata } from "../../tools/credentials/metadata-store.js";
import type { PublishProvider } from "./types.js";
import { vercelPublishProvider } from "./vercel-provider.js";
import { webhookPublishProvider } from "./webhook-provider.js";

const PROVIDERS: Record<PublishProviderId, PublishProvider> = {
  vercel: vercelPublishProvider,
  webhook: webhookPublishProvider,
};

export const DEFAULT_PUBLISH_PROVIDER_ID: PublishProviderId = "vercel";

/** The provider `apps.publish.provider` selects. */
export function getPublishProvider(): PublishProvider {
  const configured = getConfig().apps.publish.provider;
  return PROVIDERS[configured] ?? PROVIDERS[DEFAULT_PUBLISH_PROVIDER_ID];
}

export type PublishCredentialOutcome<T> =
  | { success: true; result: T }
  | { success: false; reason: string; credentialMissing: boolean };

/**
 * Run `execute` with the provider's credential.
 *
 * A required credential goes through {@link credentialBroker.serverUse}, which
 * reads the secret internally and never hands plaintext back to this layer. A
 * provider whose credential is optional and unstored runs unauthenticated.
 */
export async function withPublishCredential<T>(
  provider: PublishProvider,
  toolName: string,
  execute: (token: string | null) => Promise<T>,
): Promise<PublishCredentialOutcome<T>> {
  const { service, field, required } = provider.credential;

  if (!required && !getCredentialMetadata(service, field)) {
    try {
      return { success: true, result: await execute(null) };
    } catch (err) {
      return {
        success: false,
        reason: err instanceof Error ? err.message : String(err),
        credentialMissing: false,
      };
    }
  }

  // Boxed so a `void`-returning operation (an unpublish) is still
  // distinguishable from the broker's "no result" failure shape.
  const useResult = await credentialBroker.serverUse<{ value: T }>({
    service,
    field,
    toolName,
    execute: async (token) => ({ value: await execute(token) }),
  });

  if (useResult.success && useResult.result) {
    return { success: true, result: useResult.result.value };
  }

  const reason = useResult.reason ?? "Publish failed";
  return {
    success: false,
    reason,
    credentialMissing:
      reason.includes("No credential found") ||
      reason.includes("no stored value"),
  };
}
