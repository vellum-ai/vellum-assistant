import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockLoadConfig: () => unknown;
let mockGetIsPlatform: () => boolean;

mock.module("../config/loader.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

mock.module("../config/env-registry.js", () => ({
  getIsPlatform: () => mockGetIsPlatform(),
}));

import { preflightVoiceIngress } from "../calls/voice-ingress-preflight.js";

describe("voice ingress preflight", () => {
  beforeEach(() => {
    mockLoadConfig = () => ({
      ingress: { enabled: true, publicBaseUrl: "https://example.com" },
    });
    mockGetIsPlatform = () => false;
  });

  test("returns success immediately for platform-callback deployments", async () => {
    mockGetIsPlatform = () => true;
    mockLoadConfig = () => ({ ingress: { enabled: false } });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicBaseUrl).toBe("");
      expect(result.ingressConfig.ingress?.enabled).toBe(false);
    }
  });

  test("accepts Twilio-specific public base URL when generic ingress URL is absent", async () => {
    mockLoadConfig = () => ({
      ingress: {
        enabled: true,
        publicBaseUrl: "",
        twilioPublicBaseUrl: "https://twilio.example.com/",
      },
    });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicBaseUrl).toBe("https://twilio.example.com");
      expect(result.ingressConfig.ingress?.publicBaseUrl).toBe(
        "https://twilio.example.com",
      );
      expect(result.ingressConfig.ingress?.twilioPublicBaseUrl).toBe(
        "https://twilio.example.com/",
      );
    }
  });
});
