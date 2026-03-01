import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "http://127.0.0.1:8000",
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
});
