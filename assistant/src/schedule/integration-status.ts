import { hasTwilioCredentials } from "../calls/twilio-rest.js";
import {
  getConnectionByProvider,
  isProviderConnected,
} from "../oauth/oauth-store.js";

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
    isConnected: () => isProviderConnected("integration:google"),
  },
  {
    name: "Slack",
    category: "messaging",
    isConnected: () => isProviderConnected("integration:slack"),
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
  const results: Array<{ name: string; category: string; connected: boolean }> =
    [];
  for (const probe of INTEGRATION_PROBES) {
    results.push({
      name: probe.name,
      category: probe.category,
      connected: await probe.isConnected(),
    });
  }
  return results;
}

export async function formatIntegrationSummary(): Promise<string> {
  const summary = await getIntegrationSummary();
  return summary
    .map((s) => `${s.name} ${s.connected ? "\u2713" : "\u2717"}`)
    .join(" | ");
}

export async function hasCapability(category: string): Promise<boolean> {
  for (const probe of INTEGRATION_PROBES) {
    if (probe.category === category && (await probe.isConnected())) {
      return true;
    }
  }
  return false;
}
