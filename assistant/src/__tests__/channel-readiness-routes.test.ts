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

let mockRawConfig: Record<string, unknown> | undefined;
let mockSecureKeys: Record<string, string>;
let mockHasTwilioCredentials: boolean;
let mockPrimaryInboxAddress: string | undefined;

mock.module("../calls/twilio-rest.js", () => ({
  hasTwilioCredentials: () => mockHasTwilioCredentials,
  getPhoneNumberSid: async () => null,
  getTollFreeVerificationStatus: async () => null,
}));

mock.module("../config/env.js", () => ({}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
  loadConfig: () => {
    const raw = mockRawConfig ?? {};
    const wa = (raw.whatsapp ?? {}) as Record<string, unknown>;
    const tw = (raw.twilio ?? {}) as Record<string, unknown>;
    return {
      twilio: { phoneNumber: (tw.phoneNumber as string) ?? "" },
      whatsapp: { phoneNumber: (wa.phoneNumber as string) ?? "" },
    };
  },
  getConfig: () => {
    const raw = mockRawConfig ?? {};
    const wa = (raw.whatsapp ?? {}) as Record<string, unknown>;
    const tw = (raw.twilio ?? {}) as Record<string, unknown>;
    return {
      twilio: { phoneNumber: (tw.phoneNumber as string) ?? "" },
      whatsapp: { phoneNumber: (wa.phoneNumber as string) ?? "" },
    };
  },
  invalidateConfigCache: () => {},
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => mockSecureKeys[key] ?? null,
}));

mock.module("../email/service.js", () => ({
  getEmailService: () => ({
    getPrimaryInboxAddress: async () => mockPrimaryInboxAddress,
  }),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { createReadinessService } from "../runtime/channel-readiness-service.js";
import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("channel readiness routes — email and WhatsApp probes", () => {
  beforeEach(() => {
    mockRawConfig = undefined;
    mockSecureKeys = {};
    mockHasTwilioCredentials = false;
    mockPrimaryInboxAddress = undefined;
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

    test("ready when all prerequisites are met (including inbox)", async () => {
      mockSecureKeys = { agentmail: "test-key" };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      mockPrimaryInboxAddress = "hello@example.agentmail.to";
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email", true);

      expect(snapshot.ready).toBe(true);
      expect(snapshot.reasons).toHaveLength(0);
    });

    test("not ready when inbox is missing (remote check)", async () => {
      mockSecureKeys = { agentmail: "test-key" };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      mockPrimaryInboxAddress = undefined;
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email", true);

      expect(snapshot.ready).toBe(false);
      expect(snapshot.reasons.some((r) => r.code === "inbox_configured")).toBe(
        true,
      );
    });

    test("local-only readiness still passes without inbox check", async () => {
      mockSecureKeys = { agentmail: "test-key" };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      // No inbox configured — explicitly opt out of remote checks
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("email", false);

      // Local checks pass — remote inbox check is not included
      expect(snapshot.ready).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // WhatsApp probe — Meta WhatsApp Business API credentials
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

    test("reports not ready when Meta credentials are missing", async () => {
      mockRawConfig = {};
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(false);
      expect(
        snapshot.reasons.some((r) => r.code === "whatsapp_phone_number_id"),
      ).toBe(true);
      expect(
        snapshot.reasons.some((r) => r.code === "whatsapp_access_token"),
      ).toBe(true);
    });

    test("reports ready when all Meta credentials and display number are configured", async () => {
      mockSecureKeys = {
        [credentialKey("whatsapp", "phone_number_id")]: "123456789",
        [credentialKey("whatsapp", "access_token")]: "EAAxxxxxx",
        [credentialKey("whatsapp", "app_secret")]: "abc123",
        [credentialKey("whatsapp", "webhook_verify_token")]: "my-verify-token",
      };
      mockRawConfig = {
        whatsapp: { phoneNumber: "+15551234567" },
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(true);
      expect(snapshot.reasons).toHaveLength(0);
    });

    test("reports not ready when display phone number is missing", async () => {
      mockSecureKeys = {
        [credentialKey("whatsapp", "phone_number_id")]: "123456789",
        [credentialKey("whatsapp", "access_token")]: "EAAxxxxxx",
        [credentialKey("whatsapp", "app_secret")]: "abc123",
        [credentialKey("whatsapp", "webhook_verify_token")]: "my-verify-token",
      };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(false);
      expect(
        snapshot.reasons.some(
          (r) => r.code === "whatsapp_display_phone_number",
        ),
      ).toBe(true);
    });

    test("checks each Meta credential individually", async () => {
      mockSecureKeys = {
        [credentialKey("whatsapp", "phone_number_id")]: "123456789",
        // access_token missing
        [credentialKey("whatsapp", "app_secret")]: "abc123",
        [credentialKey("whatsapp", "webhook_verify_token")]: "my-verify-token",
      };
      mockRawConfig = {
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      expect(snapshot.ready).toBe(false);

      const phoneIdCheck = snapshot.localChecks.find(
        (c) => c.name === "whatsapp_phone_number_id",
      );
      expect(phoneIdCheck!.passed).toBe(true);

      const accessTokenCheck = snapshot.localChecks.find(
        (c) => c.name === "whatsapp_access_token",
      );
      expect(accessTokenCheck!.passed).toBe(false);

      const appSecretCheck = snapshot.localChecks.find(
        (c) => c.name === "whatsapp_app_secret",
      );
      expect(appSecretCheck!.passed).toBe(true);

      const webhookCheck = snapshot.localChecks.find(
        (c) => c.name === "whatsapp_webhook_verify_token",
      );
      expect(webhookCheck!.passed).toBe(true);
    });

    test("checks invite policy", async () => {
      mockSecureKeys = {
        [credentialKey("whatsapp", "phone_number_id")]: "123456789",
        [credentialKey("whatsapp", "access_token")]: "EAAxxxxxx",
        [credentialKey("whatsapp", "app_secret")]: "abc123",
        [credentialKey("whatsapp", "webhook_verify_token")]: "my-verify-token",
      };
      mockRawConfig = {
        whatsapp: { phoneNumber: "+15551234567" },
        ingress: { publicBaseUrl: "https://example.com", enabled: true },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      const inviteCheck = snapshot.localChecks.find(
        (c) => c.name === "invite_policy",
      );
      expect(inviteCheck).toBeDefined();
      expect(inviteCheck!.passed).toBe(true);
    });

    test("checks ingress configuration", async () => {
      mockSecureKeys = {
        [credentialKey("whatsapp", "phone_number_id")]: "123456789",
        [credentialKey("whatsapp", "access_token")]: "EAAxxxxxx",
        [credentialKey("whatsapp", "app_secret")]: "abc123",
        [credentialKey("whatsapp", "webhook_verify_token")]: "my-verify-token",
      };
      mockRawConfig = {
        whatsapp: { phoneNumber: "+15551234567" },
      };
      const service = createReadinessService();
      const [snapshot] = await service.getReadiness("whatsapp");

      const ingressCheck = snapshot.localChecks.find(
        (c) => c.name === "ingress",
      );
      expect(ingressCheck).toBeDefined();
      expect(ingressCheck!.passed).toBe(false);
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
