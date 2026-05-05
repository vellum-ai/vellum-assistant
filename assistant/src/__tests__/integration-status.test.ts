import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

const secureKeyValues = new Map<string, string>();
let mockTwilioAccountSid: string | undefined;

const connectedProviders = new Set<string>();
const managedProviders = new Set<string>();
const platformConnectedProviders = new Set<string>();

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    twilio: mockTwilioAccountSid
      ? { accountSid: mockTwilioAccountSid }
      : undefined,
  }),
  getConfig: () => ({ services: {} }),
}));

mock.module("../config/schemas/services.js", () => ({
  getServiceMode: (_services: unknown, key: string) =>
    managedProviders.has(key) ? "managed" : "your-own",
  ServicesSchema: { shape: { google: true, slack: true } },
}));

mock.module("../oauth/oauth-store.js", () => ({
  isProviderConnected: (provider: string) =>
    Promise.resolve(connectedProviders.has(provider)),
  getConnectionByProvider: (provider: string) =>
    connectedProviders.has(provider)
      ? { id: `conn-${provider}`, status: "active" }
      : undefined,
  getProvider: (provider: string) => {
    const managedKeys: Record<string, string> = {
      google: "google",
      slack: "slack",
    };
    return managedKeys[provider]
      ? { managedServiceConfigKey: managedKeys[provider] }
      : undefined;
  },
}));

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => ({
      platformAssistantId: "test-assistant",
      fetch: async (path: string) => {
        const url = new URL(`http://localhost${path}`);
        const provider = url.searchParams.get("provider");
        const hasConnections =
          provider && platformConnectedProviders.has(provider);
        return {
          ok: true,
          json: async () => (hasConnections ? [{ id: "conn-1" }] : []),
        };
      },
    }),
  },
}));

function setOAuthConnected(provider: string): void {
  connectedProviders.add(provider);
}

function setPlatformConnected(provider: string, configKey: string): void {
  managedProviders.add(configKey);
  platformConnectedProviders.add(provider);
}

const { getIntegrationSummary, formatIntegrationSummary, hasCapability } =
  await import("../schedule/integration-status.js");

describe("integration-status", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    connectedProviders.clear();
    managedProviders.clear();
    platformConnectedProviders.clear();
    mockTwilioAccountSid = undefined;
  });

  describe("getIntegrationSummary", () => {
    test("returns all disconnected when no keys are set", async () => {
      const summary = await getIntegrationSummary();
      expect(summary).toEqual([
        { name: "Gmail", category: "email", connected: false },
        { name: "Slack", category: "messaging", connected: false },
        { name: "Twilio", category: "telephony", connected: false },
        { name: "Telegram", category: "messaging", connected: false },
      ]);
    });

    test("returns all connected when all keys are set", async () => {
      setOAuthConnected("google");
      setOAuthConnected("slack");
      mockTwilioAccountSid = "sid";
      secureKeyValues.set(credentialKey("twilio", "auth_token"), "auth");
      setOAuthConnected("telegram");

      const summary = await getIntegrationSummary();
      expect(summary.every((s: { connected: boolean }) => s.connected)).toBe(
        true,
      );
    });

    test("returns mixed status", async () => {
      mockTwilioAccountSid = "sid";
      secureKeyValues.set(credentialKey("twilio", "auth_token"), "auth");
      setOAuthConnected("telegram");

      const summary = await getIntegrationSummary();
      const connected = summary.filter(
        (s: { connected: boolean }) => s.connected,
      );
      const disconnected = summary.filter(
        (s: { connected: boolean }) => !s.connected,
      );

      expect(connected.map((s: { name: string }) => s.name)).toEqual([
        "Twilio",
        "Telegram",
      ]);
      expect(disconnected.map((s: { name: string }) => s.name)).toEqual([
        "Gmail",
        "Slack",
      ]);
    });

    test("Twilio disconnected when only account_sid is set (missing auth_token)", async () => {
      mockTwilioAccountSid = "sid";

      const summary = await getIntegrationSummary();
      const twilio = summary.find((s: { name: string }) => s.name === "Twilio");
      expect(twilio?.connected).toBe(false);
    });

    test("Telegram disconnected when no connection record exists", async () => {
      const summary = await getIntegrationSummary();
      const telegram = summary.find(
        (s: { name: string }) => s.name === "Telegram",
      );
      expect(telegram?.connected).toBe(false);
    });
  });

  describe("formatIntegrationSummary", () => {
    test("shows checkmarks and crosses", async () => {
      mockTwilioAccountSid = "sid";
      secureKeyValues.set(credentialKey("twilio", "auth_token"), "auth");
      setOAuthConnected("telegram");

      const result = await formatIntegrationSummary();
      expect(result).toBe(
        "Gmail \u2717 | Slack \u2717 | Twilio \u2713 | Telegram \u2713",
      );
    });

    test("all disconnected", async () => {
      const result = await formatIntegrationSummary();
      expect(result).toBe(
        "Gmail \u2717 | Slack \u2717 | Twilio \u2717 | Telegram \u2717",
      );
    });

    test("all connected", async () => {
      setOAuthConnected("google");
      setOAuthConnected("slack");
      mockTwilioAccountSid = "sid";
      secureKeyValues.set(credentialKey("twilio", "auth_token"), "auth");
      setOAuthConnected("telegram");

      const result = await formatIntegrationSummary();
      expect(result).toBe(
        "Gmail \u2713 | Slack \u2713 | Twilio \u2713 | Telegram \u2713",
      );
    });
  });

  describe("hasCapability", () => {
    test("returns false when no integrations in category are connected", async () => {
      expect(await hasCapability("email")).toBe(false);
      expect(await hasCapability("messaging")).toBe(false);
    });

    test("returns true when any integration in category is connected", async () => {
      setOAuthConnected("telegram");
      expect(await hasCapability("messaging")).toBe(true);
    });

    test("returns false when no connection record exists for category integrations", async () => {
      expect(await hasCapability("messaging")).toBe(false);
    });

    test("returns false for unknown categories", async () => {
      expect(await hasCapability("nonexistent")).toBe(false);
    });

    test("email category checks Gmail", async () => {
      setOAuthConnected("google");
      expect(await hasCapability("email")).toBe(true);
    });
  });

  describe("managed mode", () => {
    test("Gmail shows connected when platform has active connection", async () => {
      setPlatformConnected("google", "google");

      const summary = await getIntegrationSummary();
      const gmail = summary.find((s: { name: string }) => s.name === "Gmail");
      expect(gmail?.connected).toBe(true);
    });

    test("Gmail shows disconnected when managed but no platform connection", async () => {
      managedProviders.add("google");

      const summary = await getIntegrationSummary();
      const gmail = summary.find((s: { name: string }) => s.name === "Gmail");
      expect(gmail?.connected).toBe(false);
    });

    test("Slack shows connected when platform has active connection", async () => {
      setPlatformConnected("slack", "slack");

      const summary = await getIntegrationSummary();
      const slack = summary.find((s: { name: string }) => s.name === "Slack");
      expect(slack?.connected).toBe(true);
    });

    test("formatIntegrationSummary reflects managed connections", async () => {
      setPlatformConnected("google", "google");
      setPlatformConnected("slack", "slack");

      const result = await formatIntegrationSummary();
      expect(result).toContain("Gmail \u2713");
      expect(result).toContain("Slack \u2713");
    });

    test("hasCapability returns true for managed email connection", async () => {
      setPlatformConnected("google", "google");
      expect(await hasCapability("email")).toBe(true);
    });
  });
});
