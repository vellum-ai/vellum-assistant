import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must come before source imports) ──────────────────────────

let mockSecureKeys: Record<string, string | null> = {};
let mockLoadConfigResult: Record<string, unknown> = {};
let mockCredentialStoreUnreachable = false;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? null,
  getSecureKeyResultAsync: async (key: string) => ({
    value: mockSecureKeys[key] ?? undefined,
    unreachable: mockCredentialStoreUnreachable,
  }),
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
      twilio: {
        accountSid: "AC_test_sid",
        phoneNumber: "+15550123",
      },
    };
    mockCredentialStoreUnreachable = false;
  });

  test("returns config when credentials and phone number are set", async () => {
    const config = await getTwilioConfig();
    expect(config.accountSid).toBe("AC_test_sid");
    expect(config.authToken).toBe("test_auth_token");
    expect(config.phoneNumber).toBe("+15550123");
  });

  test("throws ConfigError when account SID is missing", async () => {
    mockLoadConfigResult = {
      twilio: { accountSid: "", phoneNumber: "+15550123" },
    };
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio Account SID not configured/,
    );
  });

  test("throws ConfigError when auth token is missing", async () => {
    mockSecureKeys = {};
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio Auth Token not configured/,
    );
  });

  test("throws ConfigError when phone number is missing", async () => {
    mockLoadConfigResult = {
      twilio: {
        accountSid: "AC_test_sid",
        phoneNumber: "",
      },
    };
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio phone number not configured/,
    );
  });

  test("throws ConfigError when twilio config section is absent and no auth token", async () => {
    mockLoadConfigResult = {};
    mockSecureKeys = {};
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError for missing SID when twilio config section is absent but auth token exists", async () => {
    mockLoadConfigResult = {};
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio Account SID not configured/,
    );
  });

  test("throws credential-store-unreachable error when auth token lookup fails due to CES", async () => {
    mockSecureKeys = {};
    mockCredentialStoreUnreachable = true;
    expect(getTwilioConfig()).rejects.toThrow(
      /credential store is unreachable/,
    );
  });

  test("throws credential-store-unreachable error when both missing and CES is down", async () => {
    mockLoadConfigResult = {};
    mockSecureKeys = {};
    mockCredentialStoreUnreachable = true;
    expect(getTwilioConfig()).rejects.toThrow(
      /credential store is unreachable/,
    );
  });
});
