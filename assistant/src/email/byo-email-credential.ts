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

export const BYO_EMAIL_CREDENTIAL_SERVICES = ["resend", "mailgun"] as const;

export type ByoEmailCredentialService =
  (typeof BYO_EMAIL_CREDENTIAL_SERVICES)[number];

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
