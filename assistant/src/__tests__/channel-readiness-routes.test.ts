/**
 * Tests that the channel readiness service returns real readiness snapshots
 * for email and WhatsApp channels (not unsupported placeholders).
 *
 * Uses the same mock approach as channel-readiness-service.test.ts but
 * exercises the createReadinessService factory to verify probe registration.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the service
// ---------------------------------------------------------------------------

let mockTwilioPhoneNumberEnv: string | undefined;
let mockRawConfig: Record<string, unknown> | undefined;
let mockSecureKeys: Record<string, string>;
let mockHasTwilioCredentials: boolean;

mock.module("../calls/twilio-rest.js", () => ({
  hasTwilioCredentials: () => mockHasTwilioCredentials,
  getPhoneNumberSid: async () => null,
  getTollFreeVerificationStatus: async () => null,
}));

mock.module("../config/env.js", () => ({
  getTwilioPhoneNumberEnv: () => mockTwilioPhoneNumberEnv,
}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => mockSecureKeys[key] ?? null,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { createReadinessService } from "../runtime/channel-readiness-service.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("channel readiness routes — email and WhatsApp probes", () => {
  beforeEach(() => {
    mockTwilioPhoneNumberEnv = undefined;
    mockRawConfig = undefined;
    mockSecureKeys = {};
    mockHasTwilioCredentials = false;
  });

  // -------------------------------------------------------------------------
  // Email probe
  // -------------------------------------------------------------------------

  describe("email", () => {
    test("returns real readiness snapshot (not unsupported)", async () => {
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email");

      expect(snapshot.channel).toBe("email");
      // Should have real local checks, not the unsupported placeholder
      expect(snapshot.localChecks.length).toBeGreaterThan(0);
      expect(
        snapshot.reasons.some((r) => r.code === "unsupported_channel"),
      ).toBe(false);
    });

    test("reports not ready when AgentMail API key is missing", async () => {
      mockRawConfig = {};
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email");

      expect(snapshot.ready).toBe(false);
      expect(snapshot.reasons.some((r) => r.code === "agentmail_api_key")).toBe(
        true,
      );
    });

    test("checks invite policy", async () => {
      mockSecureKeys = { agentmail: "test-key" };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email");

      const inviteCheck = snapshot.localChecks.find(
        (c) => c.name === "invite_policy",
      );
      expect(inviteCheck).toBeDefined();
      // Email has codeRedemptionEnabled: true in the channel policy registry
      expect(inviteCheck!.passed).toBe(true);
    });

    test("checks ingress configuration", async () => {
      mockSecureKeys = { agentmail: "test-key" };
      mockRawConfig = {};
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email");

      const ingressCheck = snapshot.localChecks.find(
        (c) => c.name === "ingress",
      );
      expect(ingressCheck).toBeDefined();
      expect(ingressCheck!.passed).toBe(false);
    });

    test("ready when all prerequisites are met", async () => {
      mockSecureKeys = { agentmail: "test-key" };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email");

      expect(snapshot.ready).toBe(true);
      expect(snapshot.reasons).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // WhatsApp probe
  // -------------------------------------------------------------------------

  describe("whatsapp", () => {
    test("returns real readiness snapshot (not unsupported)", async () => {
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.channel).toBe("whatsapp");
      expect(snapshot.localChecks.length).toBeGreaterThan(0);
      expect(
        snapshot.reasons.some((r) => r.code === "unsupported_channel"),
      ).toBe(false);
    });

    test("reports not ready when Twilio credentials are missing", async () => {
      mockRawConfig = {};
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(false);
      expect(
        snapshot.reasons.some((r) => r.code === "twilio_credentials"),
      ).toBe(true);
    });

    test("reports not ready when phone number is missing", async () => {
      mockHasTwilioCredentials = true;
      mockRawConfig = {};
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(false);
      expect(snapshot.reasons.some((r) => r.code === "phone_number")).toBe(
        true,
      );
    });

    test("resolves phone number from whatsapp config", async () => {
      mockHasTwilioCredentials = true;
      mockRawConfig = {
        whatsapp: { phoneNumber: "+15551234567" },
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      const phoneCheck = snapshot.localChecks.find(
        (c) => c.name === "phone_number",
      );
      expect(phoneCheck).toBeDefined();
      expect(phoneCheck!.passed).toBe(true);
    });

    test("falls back to sms config for phone number", async () => {
      mockHasTwilioCredentials = true;
      mockRawConfig = {
        sms: { phoneNumber: "+15559876543" },
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      const phoneCheck = snapshot.localChecks.find(
        (c) => c.name === "phone_number",
      );
      expect(phoneCheck!.passed).toBe(true);
    });

    test("checks invite policy", async () => {
      mockHasTwilioCredentials = true;
      mockTwilioPhoneNumberEnv = "+15551234567";
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      const inviteCheck = snapshot.localChecks.find(
        (c) => c.name === "invite_policy",
      );
      expect(inviteCheck).toBeDefined();
      // WhatsApp has codeRedemptionEnabled: true in the channel policy registry
      expect(inviteCheck!.passed).toBe(true);
    });

    test("checks ingress configuration", async () => {
      mockHasTwilioCredentials = true;
      mockTwilioPhoneNumberEnv = "+15551234567";
      mockRawConfig = {};
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      const ingressCheck = snapshot.localChecks.find(
        (c) => c.name === "ingress",
      );
      expect(ingressCheck).toBeDefined();
      expect(ingressCheck!.passed).toBe(false);
    });

    test("ready when all prerequisites are met", async () => {
      mockHasTwilioCredentials = true;
      mockTwilioPhoneNumberEnv = "+15551234567";
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(true);
      expect(snapshot.reasons).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Factory coverage — all channels registered
  // -------------------------------------------------------------------------

  describe("createReadinessService factory", () => {
    test("registers probes for all deliverable channels including email and whatsapp", async () => {
      const service = createReadinessService();
      const snapshots = await service.getReadiness();

      const channels = snapshots.map((s) => s.channel).sort();
      expect(channels).toContain("email");
      expect(channels).toContain("whatsapp");

      // None should be unsupported placeholders
      for (const s of snapshots) {
        expect(s.reasons.some((r) => r.code === "unsupported_channel")).toBe(
          false,
        );
      }
    });
  });
});
