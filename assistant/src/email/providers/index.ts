/**
 * Email provider registry — resolves provider name → EmailProvider instance.
 *
 * Config path: integrations.email.provider (default: 'agentmail')
 */

import { getNestedValue, loadRawConfig } from "../../config/loader.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { ConfigError } from "../../util/errors.js";
import type { EmailProvider } from "../provider.js";

export const SUPPORTED_PROVIDERS = ["agentmail"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const PROVIDER_KEY_MAP: Record<SupportedProvider, string[]> = {
  agentmail: ["agentmail", credentialKey("agentmail", "api_key")],
};

/**
 * Read the active email provider from config.
 * Defaults to 'agentmail' if not set.
 */
export function getActiveProviderName(): SupportedProvider {
  const raw = loadRawConfig();
  const value = getNestedValue(raw, "integrations.email.provider");
  if (
    typeof value === "string" &&
    SUPPORTED_PROVIDERS.includes(value as SupportedProvider)
  ) {
    return value as SupportedProvider;
  }
  return "agentmail";
}

/**
 * Create an EmailProvider instance for the given (or active) provider.
 * Throws if the API key is missing.
 */
export async function createProvider(
  name?: SupportedProvider,
): Promise<EmailProvider> {
  const providerName = name ?? getActiveProviderName();

  switch (providerName) {
    case "agentmail": {
      const candidates = PROVIDER_KEY_MAP.agentmail;
      let apiKey: string | undefined;
      for (const account of candidates) {
        const result = await getSecureKeyAsync(account);
        apiKey = result.value;
        if (apiKey) break;
      }
      if (!apiKey) {
        throw new ConfigError(
          "No AgentMail API key configured. Run: assistant keys set agentmail <key>",
        );
      }
      const { AgentMailClient } = await import("agentmail");
      const { AgentMailProvider } = await import("./agentmail.js");
      return new AgentMailProvider(new AgentMailClient({ apiKey }));
    }
    default:
      throw new ConfigError(`Unknown email provider: ${providerName}`);
  }
}
