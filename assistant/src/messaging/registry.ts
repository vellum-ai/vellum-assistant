/**
 * Messaging provider registry — register/lookup providers by platform ID.
 */

import { isProviderConnected } from "../oauth/oauth-store.js";
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
export async function getConnectedProviders(): Promise<MessagingProvider[]> {
  const results: MessagingProvider[] = [];
  for (const p of providers.values()) {
    const connected = p.isConnected
      ? await p.isConnected()
      : await isProviderConnected(p.credentialService);
    if (connected) results.push(p);
  }
  return results;
}
