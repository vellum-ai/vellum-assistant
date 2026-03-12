/**
 * Messaging provider registry — register/lookup providers by platform ID.
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKey } from "../security/secure-keys.js";
import type { MessagingProvider } from "./provider.js";

const providers = new Map<string, MessagingProvider>();

export function registerMessagingProvider(provider: MessagingProvider): void {
  providers.set(provider.id, provider);
}

export function getMessagingProvider(id: string): MessagingProvider {
  const provider = providers.get(id);
  if (!provider) {
    const available = Array.from(providers.keys()).join(", ") || "none";
    throw new Error(
      `Messaging provider "${id}" not found. Available: ${available}`,
    );
  }
  return provider;
}

/** Return all registered providers that have stored credentials. */
export function getConnectedProviders(): MessagingProvider[] {
  return Array.from(providers.values()).filter((p) => {
    if (p.isConnected) return p.isConnected();
    const token = getSecureKey(
      credentialKey(p.credentialService, "access_token"),
    );
    return token !== undefined;
  });
}

/** Return all registered provider IDs. */
export function getRegisteredProviderIds(): string[] {
  return Array.from(providers.keys());
}
