/**
 * Messaging provider registry — register/lookup providers by platform ID.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKey } from "../security/secure-keys.js";
import type { MessagingProvider } from "./provider.js";

/**
 * Per-platform feature flag keys. Platforms not listed here are allowed
 * by default (undeclared keys resolve to `true`).
 */
const PLATFORM_FLAG_KEYS: Record<string, string> = {
  gmail: "feature_flags.messaging.gmail.enabled",
};

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
  assertPlatformEnabled(id);
  return provider;
}

export function isPlatformEnabled(platformId: string): boolean {
  const flagKey = PLATFORM_FLAG_KEYS[platformId];
  if (!flagKey) return true;
  return isAssistantFeatureFlagEnabled(flagKey, getConfig());
}

function assertPlatformEnabled(platformId: string): void {
  if (!isPlatformEnabled(platformId)) {
    throw new Error(
      `The ${platformId} platform is not enabled. Enable it in Settings > Features.`,
    );
  }
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
