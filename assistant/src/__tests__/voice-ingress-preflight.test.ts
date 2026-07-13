import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realEnvRegistry from "../config/env-registry.js";
import { setConfig } from "./helpers/set-config.js";

let mockGetIsPlatform: () => boolean;
let mockCredentialReadiness: Record<string, unknown>;
let credentialReadinessCalls = 0;

// Spread the real env-registry so the now-real config loader's transitive
// `util/platform` imports (getWorkspaceDirOverride, etc.) still resolve; only
// getIsPlatform is driven per test.
mock.module("../config/env-registry.js", () => ({
  ...realEnvRegistry,
  getIsPlatform: () => mockGetIsPlatform(),
}));

mock.module("../calls/telephony-credential-preflight.js", () => ({
  resolveTelephonyCredentialReadiness: async () => {
    credentialReadinessCalls++;
    return mockCredentialReadiness;
  },
}));

import { preflightVoiceIngress } from "../calls/voice-ingress-preflight.js";

const NOT_READY = {
  status: "not-ready",
  missing: [
    {
      kind: "stt",
      providerId: "deepgram",
      reason: 'No API key configured for credential provider "deepgram"',
    },
  ],
  userMessage:
    'Phone calls are unavailable because they require an API key for the speech-to-text provider "deepgram".',
};

describe("voice ingress preflight", () => {
  beforeEach(() => {
    setConfig("ingress", {
      enabled: true,
      publicBaseUrl: "https://example.com",
    });
    mockGetIsPlatform = () => false;
    mockCredentialReadiness = { status: "ready" };
    credentialReadinessCalls = 0;
  });

  test("returns success immediately for platform-callback deployments", async () => {
    mockGetIsPlatform = () => true;
    setConfig("ingress", { enabled: false });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicBaseUrl).toBe("");
      expect(result.ingressConfig.ingress?.enabled).toBe(false);
    }
  });

  test("accepts public base URL for Twilio when configured", async () => {
    setConfig("ingress", {
      enabled: true,
      publicBaseUrl: "https://twilio.example.com/",
    });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicBaseUrl).toBe("https://twilio.example.com");
      expect(result.ingressConfig.ingress?.publicBaseUrl).toBe(
        "https://twilio.example.com",
      );
    }
  });

  test("fails with the readiness user message when credentials are not ready", async () => {
    mockCredentialReadiness = NOT_READY;

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain('speech-to-text provider "deepgram"');
    }
  });

  test("credential readiness gates platform-callback deployments too", async () => {
    // The platform short-circuit covers only the ingress-URL half — the
    // daemon still performs STT/TTS on platform deployments.
    mockGetIsPlatform = () => true;
    setConfig("ingress", { enabled: false });
    mockCredentialReadiness = NOT_READY;

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('speech-to-text provider "deepgram"');
    }
  });

  test("runs the credential readiness check on the platform success path", async () => {
    mockGetIsPlatform = () => true;
    setConfig("ingress", { enabled: false });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    expect(credentialReadinessCalls).toBe(1);
  });
});
