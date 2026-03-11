import { hasTwilioCredentials } from "../calls/twilio-rest.js";
import { getSecureKey } from "../security/secure-keys.js";

interface IntegrationProbe {
  name: string;
  category: string;
  isConnected: () => boolean;
}

// Registry — add new integrations here:
const INTEGRATION_PROBES: IntegrationProbe[] = [
  {
    name: "Gmail",
    category: "email",
    isConnected: () =>
      !!getSecureKey("credential:integration:gmail:access_token"),
  },
  {
    name: "Slack",
    category: "messaging",
    isConnected: () =>
      !!getSecureKey("credential:integration:slack:access_token"),
  },
  {
    name: "Twilio",
    category: "telephony",
    isConnected: () => hasTwilioCredentials(),
  },
  {
    name: "Telegram",
    category: "messaging",
    isConnected: () =>
      !!getSecureKey("credential:telegram:bot_token") &&
      !!getSecureKey("credential:telegram:webhook_secret"),
  },
];

export function getIntegrationSummary(): Array<{
  name: string;
  category: string;
  connected: boolean;
}> {
  return INTEGRATION_PROBES.map((probe) => ({
    name: probe.name,
    category: probe.category,
    connected: probe.isConnected(),
  }));
}

export function formatIntegrationSummary(): string {
  const summary = getIntegrationSummary();
  return summary
    .map((s) => `${s.name} ${s.connected ? "\u2713" : "\u2717"}`)
    .join(" | ");
}

export function hasCapability(category: string): boolean {
  return INTEGRATION_PROBES.some(
    (probe) => probe.category === category && probe.isConnected(),
  );
}
