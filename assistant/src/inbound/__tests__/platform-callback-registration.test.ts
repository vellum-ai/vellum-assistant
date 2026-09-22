/**
 * The callback-registration context is what `platform/status` reports to
 * clients. The property under test is that "no key" and "could not look"
 * are told apart: a client that provisions a key when it sees none must not
 * be told "none" by a daemon whose credential store did not answer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const vault: Record<string, string> = {};
let vaultUnreachable = false;

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) =>
    vaultUnreachable ? undefined : vault[account],
  getSecureKeyResultAsync: async (account: string) =>
    vaultUnreachable
      ? { value: undefined, unreachable: true }
      : { value: vault[account], unreachable: false },
}));

mock.module("../../config/platform-identity.js", () => ({
  resolvePlatformAssistantId: async () =>
    "019ed7d1-e995-71cc-9859-c54f422ace3c",
}));

mock.module("../../config/env.js", () => ({
  getPlatformBaseUrl: () => "https://platform.example.com",
}));

mock.module("../../config/env-registry.js", () => ({
  getIsPlatform: () => false,
}));

const { resolvePlatformCallbackRegistrationContext } =
  await import("../platform-callback-registration.js");

const API_KEY_ACCOUNT = "credential/vellum/assistant_api_key";
const originalEnvKey = process.env.ASSISTANT_API_KEY;

beforeEach(() => {
  for (const key of Object.keys(vault)) {
    delete vault[key];
  }
  vaultUnreachable = false;
  delete process.env.ASSISTANT_API_KEY;
});

afterEach(() => {
  if (originalEnvKey === undefined) {
    delete process.env.ASSISTANT_API_KEY;
  } else {
    process.env.ASSISTANT_API_KEY = originalEnvKey;
  }
});

describe("resolvePlatformCallbackRegistrationContext", () => {
  test("reports the key as present when the store holds one", async () => {
    vault[API_KEY_ACCOUNT] = "stored-key";

    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.hasAssistantApiKey).toBe(true);
    expect(context.authHeader).toBe("Api-Key stored-key");
  });

  test("reports the key as missing when the store answers and holds none", async () => {
    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.hasAssistantApiKey).toBe(false);
    expect(context.authHeader).toBeNull();
  });

  test("reports the key state as unknown when the store did not answer", async () => {
    vaultUnreachable = true;

    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.hasAssistantApiKey).toBeNull();
    expect(context.authHeader).toBeNull();
    expect(context.enabled).toBe(false);
  });

  test("an environment key counts as present even when the store did not answer", async () => {
    vaultUnreachable = true;
    process.env.ASSISTANT_API_KEY = "env-key";

    const context = await resolvePlatformCallbackRegistrationContext();

    expect(context.hasAssistantApiKey).toBe(true);
    expect(context.authHeader).toBe("Api-Key env-key");
  });
});
