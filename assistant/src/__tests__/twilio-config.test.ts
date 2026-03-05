import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must come before source imports) ──────────────────────────

let mockSecureKeys: Record<string, string | null> = {};
let mockPhoneNumberEnv: string | undefined;
let mockLoadConfigResult: Record<string, unknown> = {};

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => mockSecureKeys[key] ?? null,
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getTwilioPhoneNumberEnv: () => mockPhoneNumberEnv,
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => mockLoadConfigResult,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: () => "https://test.example.com",
  getTwilioRelayUrl: () => "wss://test.example.com/twilio/relay",
}));

import { getTwilioConfig } from "../calls/twilio-config.js";

describe("twilio-config", () => {
  beforeEach(() => {
    mockSecureKeys = {
      "credential:twilio:account_sid": "AC_test_sid",
      "credential:twilio:auth_token": "test_auth_token",
    };
    mockPhoneNumberEnv = undefined;
    mockLoadConfigResult = {
      sms: { phoneNumber: "+15551234567" },
    };
  });

  test("returns config when credentials and phone number are set", () => {
    const config = getTwilioConfig();
    expect(config.accountSid).toBe("AC_test_sid");
    expect(config.authToken).toBe("test_auth_token");
    expect(config.phoneNumber).toBe("+15551234567");
    expect(config.webhookBaseUrl).toBe("https://test.example.com");
    expect(config.wssBaseUrl).toBe("wss://test.example.com/twilio/relay");
  });

  test("throws ConfigError when account SID is missing", () => {
    mockSecureKeys["credential:twilio:account_sid"] = null;
    expect(() => getTwilioConfig()).toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError when auth token is missing", () => {
    mockSecureKeys["credential:twilio:auth_token"] = null;
    expect(() => getTwilioConfig()).toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError when phone number is missing", () => {
    mockLoadConfigResult = { sms: {} };
    mockPhoneNumberEnv = undefined;
    mockSecureKeys["credential:twilio:phone_number"] = null;
    expect(() => getTwilioConfig()).toThrow(
      /Twilio phone number not configured/,
    );
  });

  test("prefers TWILIO_PHONE_NUMBER env var over config phone number", () => {
    mockPhoneNumberEnv = "+15559999999";
    const config = getTwilioConfig();
    expect(config.phoneNumber).toBe("+15559999999");
  });

  test("falls back to secure key for phone number", () => {
    mockLoadConfigResult = { sms: {} };
    mockPhoneNumberEnv = undefined;
    mockSecureKeys["credential:twilio:phone_number"] = "+15558888888";
    const config = getTwilioConfig();
    expect(config.phoneNumber).toBe("+15558888888");
  });

  test("returns global phone number when assistantPhoneNumbers mapping exists", () => {
    mockLoadConfigResult = {
      sms: {
        phoneNumber: "+15551234567",
        assistantPhoneNumbers: { "ast-1": "+15557777777" },
      },
    };
    const config = getTwilioConfig();
    expect(config.phoneNumber).toBe("+15551234567");
  });
});
