import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

const secureKeyValues = new Map<string, string>();
let mockTwilioAccountSid: string | undefined;

/** Set of providers that should report as connected via isProviderConnected(). */
const connectedProviders = new Set<string>();

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    twilio: mockTwilioAccountSid
      ? { accountSid: mockTwilioAccountSid }
      : undefined,
  }),
}));

mock.module("../oauth/oauth-store.js", () => ({
  isProviderConnected: (providerKey: string) =>
    connectedProviders.has(providerKey),
  getConnectionByProvider: (providerKey: string) =>
    connectedProviders.has(providerKey)
      ? { id: `conn-${providerKey}`, status: "active" }
      : undefined,
}));

/** Mark a provider as fully connected (active row + access token). */
function setOAuthConnected(providerKey: string): void {
  connectedProviders.add(providerKey);
}

const { getIntegrationSummary, formatIntegrationSummary, hasCapability } =
  await import("../schedule/integration-status.js");

describe("integration-status", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    connectedProviders.clear();
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
      setOAuthConnected("integration:google");
      setOAuthConnected("integration:slack");
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
      // No oauth_connection record for telegram — should be disconnected
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
      setOAuthConnected("integration:google");
      setOAuthConnected("integration:slack");
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
      // No oauth_connection record for telegram — should not count as connected
      expect(await hasCapability("messaging")).toBe(false);
    });

    test("returns false for unknown categories", async () => {
      expect(await hasCapability("nonexistent")).toBe(false);
    });

    test("email category checks Gmail", async () => {
      setOAuthConnected("integration:google");
      expect(await hasCapability("email")).toBe(true);
    });
  });
});
