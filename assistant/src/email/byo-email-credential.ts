/**
 * "Your own" (BYO) email providers: the assistant sends and receives email
 * through the user's own provider account instead of a platform-managed
 * inbox. Configuration is the provider's stored `api_key` credential;
 * inbound arrives through the gateway's per-provider webhook routes
 * (`gateway/src/http/routes/resend-webhook.ts`, `mailgun-webhook.ts`).
 *
 * The service ids here are the credential-store service names those webhook
 * routes and the web client's BYO setup read (`EMAIL_BYO_PROVIDERS` in
 * `clients/web/src/lib/provider-catalogs.ts` mirrors this list). Adding a
 * provider means a new gateway webhook route and a web catalog entry, so
 * extend all three together.
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("byo-email-credential");

export const BYO_EMAIL_CREDENTIAL_SERVICES = ["resend", "mailgun"] as const;

export type ByoEmailCredentialService =
  (typeof BYO_EMAIL_CREDENTIAL_SERVICES)[number];

export function isByoEmailCredentialService(
  service: string,
): service is ByoEmailCredentialService {
  return BYO_EMAIL_CREDENTIAL_SERVICES.some((s) => s === service);
}

/**
 * The first BYO email provider whose API key is stored, or `undefined` when
 * none is configured. Credential presence is the configuration claim, the
 * same standard the other channels' readiness checks apply to their tokens.
 */
export async function resolveConfiguredByoEmailService(): Promise<
  ByoEmailCredentialService | undefined
> {
  for (const service of BYO_EMAIL_CREDENTIAL_SERVICES) {
    if (await getSecureKeyAsync(credentialKey(service, "api_key"))) {
      return service;
    }
  }
  return undefined;
}

/**
 * A stored or deleted BYO email provider key changes the email channel's
 * readiness verdict, and that check lives in the readiness service's
 * TTL-cached remote bucket; drop the cached snapshot so the next readiness
 * read re-evaluates instead of serving the pre-write answer for the rest of
 * the TTL. Called from the credential write and delete paths. Best-effort:
 * the credential change already succeeded, and a missed invalidation
 * self-heals when the TTL lapses.
 */
export async function invalidateEmailReadinessForByoCredential(
  service: string,
): Promise<void> {
  if (!isByoEmailCredentialService(service)) {
    return;
  }
  try {
    // Lazily imported: the readiness service sits in the daemon handler
    // graph, which credential writers (CLI, plugin API) should not load
    // unless a BYO email key actually changed.
    const { getReadinessService } =
      await import("../daemon/handlers/config-channels.js");
    getReadinessService().invalidateChannel("email");
  } catch (err) {
    log.warn(
      { err, service },
      "Credential change succeeded, but email readiness invalidation failed",
    );
  }
}
