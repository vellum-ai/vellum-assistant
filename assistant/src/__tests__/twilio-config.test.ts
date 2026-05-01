import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must come before source imports) ──────────────────────────

let mockSecureKeys: Record<string, string | null> = {};
let mockLoadConfigResult: Record<string, unknown> = {};

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? null,
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => mockLoadConfigResult,
}));

import { getTwilioConfig } from "../calls/twilio-config.js";
import { credentialKey } from "../security/credential-key.js";

describe("twilio-config", () => {
  beforeEach(() => {
    mockSecureKeys = {
      [credentialKey("twilio", "auth_token")]: "test_auth_token",
    };
    mockLoadConfigResult = {
      ingress: {
        publicBaseUrl: "https://test.example.com",
      },
      twilio: {
        accountSid: "AC_test_sid",
        phoneNumber: "+15550123",
      },
    };
  });

  test("returns config when credentials and phone number are set", async () => {
    const config = await getTwilioConfig();
    expect(config.accountSid).toBe("AC_test_sid");
    expect(config.authToken).toBe("test_auth_token");
    expect(config.phoneNumber).toBe("+15550123");
    expect(config.webhookBaseUrl).toBe("https://test.example.com");
    expect(config.wssBaseUrl).toBe(
      "wss://test.example.com/webhooks/twilio/relay",
    );
  });

  test("uses Twilio-specific public base URL when generic ingress is empty", async () => {
    mockLoadConfigResult = {
      ingress: {
        publicBaseUrl: "  https://twilio.example.com///  ",
      },
      twilio: {
        accountSid: "AC_test_sid",
        phoneNumber: "+15550123",
      },
    };

    const config = await getTwilioConfig();

    expect(config.webhookBaseUrl).toBe("https://twilio.example.com");
    expect(config.wssBaseUrl).toBe(
      "wss://twilio.example.com/webhooks/twilio/relay",
    );
  });

  test("throws ConfigError when account SID is missing", async () => {
    mockLoadConfigResult = {
      ingress: {
        publicBaseUrl: "https://test.example.com",
      },
      twilio: { accountSid: "", phoneNumber: "+15550123" },
    };
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError when auth token is missing", async () => {
    mockSecureKeys = {};
    mockLoadConfigResult = {
      ingress: {
        publicBaseUrl: "https://test.example.com",
      },
      twilio: {
        accountSid: "AC_test_sid",
        phoneNumber: "+15550123",
      },
    };
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError when phone number is missing", async () => {
    mockLoadConfigResult = {
      ingress: {
        publicBaseUrl: "https://test.example.com",
      },
      twilio: {
        accountSid: "AC_test_sid",
        phoneNumber: "",
      },
    };
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio phone number not configured/,
    );
  });

  test("throws ConfigError when twilio config section is absent", async () => {
    mockLoadConfigResult = {
      ingress: {
        publicBaseUrl: "https://test.example.com",
      },
    };
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });
});
