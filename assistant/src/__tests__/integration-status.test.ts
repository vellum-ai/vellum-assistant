import { beforeEach, describe, expect, mock, test } from "bun:test";

const secureKeyValues = new Map<string, string>();

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => secureKeyValues.get(account),
}));

const { getIntegrationSummary, formatIntegrationSummary, hasCapability } =
  await import("../schedule/integration-status.js");

describe("integration-status", () => {
  beforeEach(() => {
    secureKeyValues.clear();
  });

  describe("getIntegrationSummary", () => {
    test("returns all disconnected when no keys are set", () => {
      const summary = getIntegrationSummary();
      expect(summary).toEqual([
        { name: "Gmail", category: "email", connected: false },
        { name: "Twitter", category: "social", connected: false },
        { name: "Slack", category: "messaging", connected: false },
        { name: "Telegram", category: "messaging", connected: false },
      ]);
    });

    test("returns all connected when all keys are set", () => {
      secureKeyValues.set("credential:integration:gmail:access_token", "tok");
      secureKeyValues.set("credential:integration:twitter:access_token", "tok");
      secureKeyValues.set("credential:integration:slack:access_token", "tok");
      secureKeyValues.set("credential:telegram:bot_token", "tok");
      secureKeyValues.set("credential:telegram:webhook_secret", "secret");

      const summary = getIntegrationSummary();
      expect(summary.every((s: { connected: boolean }) => s.connected)).toBe(
        true,
      );
    });

    test("returns mixed status", () => {
      secureKeyValues.set("credential:telegram:bot_token", "tok");
      secureKeyValues.set("credential:telegram:webhook_secret", "secret");

      const summary = getIntegrationSummary();
      const connected = summary.filter(
        (s: { connected: boolean }) => s.connected,
      );
      const disconnected = summary.filter(
        (s: { connected: boolean }) => !s.connected,
      );

      expect(connected.map((s: { name: string }) => s.name)).toEqual([
        "Telegram",
      ]);
      expect(disconnected.map((s: { name: string }) => s.name)).toEqual([
        "Gmail",
        "Twitter",
        "Slack",
      ]);
    });

    test("Telegram disconnected when only bot_token is set (missing webhook_secret)", () => {
      secureKeyValues.set("credential:telegram:bot_token", "tok");

      const summary = getIntegrationSummary();
      const telegram = summary.find(
        (s: { name: string }) => s.name === "Telegram",
      );
      expect(telegram?.connected).toBe(false);
    });
  });

  describe("formatIntegrationSummary", () => {
    test("shows checkmarks and crosses", () => {
      secureKeyValues.set("credential:telegram:bot_token", "tok");
      secureKeyValues.set("credential:telegram:webhook_secret", "secret");

      const result = formatIntegrationSummary();
      expect(result).toBe(
        "Gmail \u2717 | Twitter \u2717 | Slack \u2717 | Telegram \u2713",
      );
    });

    test("all disconnected", () => {
      const result = formatIntegrationSummary();
      expect(result).toBe(
        "Gmail \u2717 | Twitter \u2717 | Slack \u2717 | Telegram \u2717",
      );
    });

    test("all connected", () => {
      secureKeyValues.set("credential:integration:gmail:access_token", "tok");
      secureKeyValues.set("credential:integration:twitter:access_token", "tok");
      secureKeyValues.set("credential:integration:slack:access_token", "tok");
      secureKeyValues.set("credential:telegram:bot_token", "tok");
      secureKeyValues.set("credential:telegram:webhook_secret", "secret");

      const result = formatIntegrationSummary();
      expect(result).toBe(
        "Gmail \u2713 | Twitter \u2713 | Slack \u2713 | Telegram \u2713",
      );
    });
  });

  describe("hasCapability", () => {
    test("returns false when no integrations in category are connected", () => {
      expect(hasCapability("email")).toBe(false);
      expect(hasCapability("social")).toBe(false);
      expect(hasCapability("messaging")).toBe(false);
    });

    test("returns true when any integration in category is connected", () => {
      secureKeyValues.set("credential:telegram:bot_token", "tok");
      secureKeyValues.set("credential:telegram:webhook_secret", "secret");
      expect(hasCapability("messaging")).toBe(true);
    });

    test("returns false when only partial credentials exist for category integrations", () => {
      secureKeyValues.set("credential:telegram:bot_token", "tok");
      // Missing webhook_secret — Telegram should not count as connected
      expect(hasCapability("messaging")).toBe(false);
    });

    test("returns false for unknown categories", () => {
      expect(hasCapability("nonexistent")).toBe(false);
    });

    test("email category checks Gmail", () => {
      secureKeyValues.set("credential:integration:gmail:access_token", "tok");
      expect(hasCapability("email")).toBe(true);
    });
  });
});
