/**
 * Regression test: guardian verification calls must create a voice channel
 * binding so the conversation never appears as an unbound desktop thread.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "guardian-verify-binding-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../calls/twilio-config.js", () => ({
  getTwilioConfig: () => ({
    accountSid: "AC_test",
    authToken: "test_token",
    phoneNumber: "+15550001111",
    webhookBaseUrl: "https://test.example.com",
    wssBaseUrl: "wss://test.example.com",
  }),
}));

mock.module("../calls/twilio-provider.js", () => ({
  TwilioConversationRelayProvider: class {
    async checkCallerIdEligibility() {
      return { eligible: true };
    }
    async initiateCall() {
      return { callSid: "CA_test_guardian_verify" };
    }
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: () => null,
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getTwilioUserPhoneNumber: () => null,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getTwilioVoiceWebhookUrl: () => "https://test.example.com/voice",
  getTwilioStatusCallbackUrl: () => "https://test.example.com/status",
}));

mock.module("../calls/voice-ingress-preflight.js", () => ({
  preflightVoiceIngress: async () => ({
    ok: true as const,
    ingressConfig: {},
    publicBaseUrl: "https://test.example.com",
  }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    calls: {
      callerIdentity: {
        allowPerCallOverride: true,
      },
    },
  }),
}));

mock.module("../runtime/channel-verification-service.js", () => ({
  isGuardian: () => false,
}));

mock.module("../memory/conversation-title-service.js", () => ({
  queueGenerateConversationTitle: () => {},
}));

import { startGuardianVerificationCall } from "../calls/call-domain.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { initializeDb, resetDb } from "../memory/db.js";
import { getBindingByConversation } from "../memory/external-conversation-store.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("startGuardianVerificationCall — voice binding", () => {
  test("creates a voice channel binding for the guardian verification conversation", async () => {
    const sessionId = "gv-session-001";
    const result = await startGuardianVerificationCall({
      phoneNumber: "+15559999999",
      guardianVerificationSessionId: sessionId,
    });

    expect(result.ok).toBe(true);

    // Look up the conversation that was created for this guardian verification
    const convKey = `guardian-verify:${sessionId}`;
    const { conversationId } = getOrCreateConversation(convKey);

    // The conversation must have a voice channel binding
    const binding = getBindingByConversation(conversationId);
    expect(binding).not.toBeNull();
    expect(binding!.sourceChannel).toBe("voice");
  });
});
