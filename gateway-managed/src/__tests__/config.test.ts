import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MANAGED_GATEWAY_ENABLED: "true",
  MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
  MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "http://127.0.0.1:8000",
  MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "bearer",
  MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE: "managed-gateway-internal",
  MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
    "token-active": {
      token_id: "mgw-active",
      principal: "managed-gateway-staging",
      audience: "managed-gateway-internal",
      scopes: ["managed-gateway:internal", "routes:resolve"],
    },
  }),
  MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
  MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS: "",
  MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
    "twilio-current": {
      token_id: "twilio-2026-01",
      auth_token: "twilio-current-secret",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  }),
  MANAGED_GATEWAY_TWILIO_REVOKED_TOKEN_IDS: "",
};

describe("loadConfig", () => {
  test("throws when enabled and strict validation is on without upstream URL", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_ENABLED: "true",
        MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
        MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "",
      }),
    ).toThrow(
      "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL is required when MANAGED_GATEWAY_ENABLED=true.",
    );
  });

  test("throws when upstream URL is not absolute", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_ENABLED: "true",
        MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
        MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "not-a-url",
      }),
    ).toThrow(
      "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL must be a valid absolute URL.",
    );
  });

  test("throws when upstream URL is not http/https", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_ENABLED: "true",
        MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
        MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "ftp://managed-gateway.internal",
      }),
    ).toThrow("MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL must use http or https.");
  });

  test("allows missing upstream URL when managed gateway is disabled", () => {
    const config = loadConfig({
      ...BASE_ENV,
      MANAGED_GATEWAY_ENABLED: "false",
      MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
      MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "",
    });

    expect(config.enabled).toBe(false);
    expect(config.djangoInternalBaseUrl).toBeNull();
  });

  test("allows missing upstream URL when strict validation is disabled", () => {
    const config = loadConfig({
      ...BASE_ENV,
      MANAGED_GATEWAY_ENABLED: "true",
      MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "false",
      MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "",
    });

    expect(config.enabled).toBe(true);
    expect(config.strictStartupValidation).toBe(false);
    expect(config.djangoInternalBaseUrl).toBeNull();
  });

  test("rejects unsupported internal auth mode", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "invalid-mode",
      }),
    ).toThrow("MANAGED_GATEWAY_INTERNAL_AUTH_MODE must be one of: bearer, mtls.");
  });

  test("requires bearer token catalog when bearer mode is enabled", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "bearer",
        MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: "{}",
      }),
    ).toThrow(
      "MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS must define at least one token when bearer mode is enabled.",
    );
  });

  test("requires mtls principal list when mtls mode is enabled", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "mtls",
        MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "",
      }),
    ).toThrow(
      "MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS must define at least one principal when mTLS mode is enabled.",
    );
  });

  test("requires at least one active Twilio auth token when enabled", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: "{}",
      }),
    ).toThrow(
      "MANAGED_GATEWAY_TWILIO_AUTH_TOKENS must define at least one active token when managed gateway is enabled.",
    );
  });

  test("rejects invalid Twilio auth token catalog JSON", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: "{invalid-json",
      }),
    ).toThrow(
      "MANAGED_GATEWAY_TWILIO_AUTH_TOKENS must be valid JSON.",
    );
  });
});
