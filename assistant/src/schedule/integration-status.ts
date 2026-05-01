import { hasTwilioCredentials } from "../calls/twilio-rest.js";
import type { Services } from "../config/schemas/services.js";
import {
  getConnectionByProvider,
  getProvider,
  isProviderConnected,
} from "../oauth/oauth-store.js";

/**
 * Check whether a provider has an active connection, handling both BYO
 * (local SQLite) and managed (platform) modes.
 */
async function isOAuthProviderConnected(provider: string): Promise<boolean> {
  const providerRow = getProvider(provider);
  const managedKey = providerRow?.managedServiceConfigKey;

  if (managedKey) {
    try {
      const { ServicesSchema, getServiceMode } =
        await import("../config/schemas/services.js");

      if (managedKey in ServicesSchema.shape) {
        const { getConfig } = await import("../config/loader.js");
        const services: Services = getConfig().services;
        if (
          getServiceMode(services, managedKey as keyof Services) === "managed"
        ) {
          return isProviderConnectedOnPlatform(provider);
        }
      }
    } catch {
      // Config unavailable — fall through to BYO check
    }
  }

  return isProviderConnected(provider);
}

/**
 * Check the platform for active connections for a managed provider.
 * Returns false on any error (network, auth, etc.) rather than throwing.
 */
async function isProviderConnectedOnPlatform(
  provider: string,
): Promise<boolean> {
  try {
    const { VellumPlatformClient } = await import("../platform/client.js");
    const client = await VellumPlatformClient.create();
    if (!client?.platformAssistantId) return false;

    const params = new URLSearchParams();
    params.set("provider", provider);
    params.set("status", "ACTIVE");

    const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
    const response = await client.fetch(path);

    if (!response.ok) return false;

    const body = (await response.json()) as unknown;
    const connections = Array.isArray(body)
      ? body
      : ((body as Record<string, unknown>).results ?? []);

    return (connections as unknown[]).length > 0;
  } catch {
    return false;
  }
}

interface IntegrationProbe {
  name: string;
  category: string;
  isConnected: () => Promise<boolean>;
}

// Registry — add new integrations here:
const INTEGRATION_PROBES: IntegrationProbe[] = [
  {
    name: "Gmail",
    category: "email",
    isConnected: () => isOAuthProviderConnected("google"),
  },
  {
    name: "Slack",
    category: "messaging",
    isConnected: () => isOAuthProviderConnected("slack"),
  },
  {
    name: "Twilio",
    category: "telephony",
    isConnected: async () => hasTwilioCredentials(),
  },
  {
    name: "Telegram",
    category: "messaging",
    isConnected: async () => {
      const conn = getConnectionByProvider("telegram");
      return !!(conn && conn.status === "active");
    },
  },
];

export async function getIntegrationSummary(): Promise<
  Array<{
    name: string;
    category: string;
    connected: boolean;
  }>
> {
  return Promise.all(
    INTEGRATION_PROBES.map(async (probe) => ({
      name: probe.name,
      category: probe.category,
      connected: await probe.isConnected(),
    })),
  );
}

export async function formatIntegrationSummary(): Promise<string> {
  const summary = await getIntegrationSummary();
  return summary
    .map((s) => `${s.name} ${s.connected ? "\u2713" : "\u2717"}`)
    .join(" | ");
}

export async function hasCapability(category: string): Promise<boolean> {
  const results = await Promise.all(
    INTEGRATION_PROBES.filter((probe) => probe.category === category).map(
      (probe) => probe.isConnected(),
    ),
  );
  return results.some(Boolean);
}
