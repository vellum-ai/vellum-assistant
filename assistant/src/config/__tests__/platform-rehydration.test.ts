import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../../security/credential-key.js";

let mockSecureKeys: Record<string, string> = {};
let throwForKey: string | undefined;

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (throwForKey && key === throwForKey) {
      throw new Error("credential store unreachable");
    }
    return mockSecureKeys[key] ?? undefined;
  },
  // Peer tests in a combined run import this name from the same module; stub
  // it so their ESM named-import validation is satisfied when this mock wins.
  deleteSecureKeyAsync: async () => ({ deleted: false }),
}));

const {
  getPlatformAssistantId,
  getPlatformBaseUrl,
  getPlatformOrganizationId,
  getPlatformUserId,
  setPlatformAssistantId,
  setPlatformBaseUrl,
  setPlatformOrganizationId,
  setPlatformUserId,
} = await import("../env.js");
const { rehydratePlatformCredentials } =
  await import("../platform-rehydration.js");

const PROD_URL = "https://platform.vellum.ai";
const ASSISTANT_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";

describe("rehydratePlatformCredentials", () => {
  const originalPlatformUrlEnv = process.env.VELLUM_PLATFORM_URL;
  const originalOrgEnv = process.env.PLATFORM_ORGANIZATION_ID;
  const originalUserEnv = process.env.PLATFORM_USER_ID;

  beforeEach(() => {
    mockSecureKeys = {};
    throwForKey = undefined;
    // Env vars take precedence over the rehydrated overrides for some fields;
    // clear them so the credential-store values are what we observe.
    delete process.env.VELLUM_PLATFORM_URL;
    delete process.env.PLATFORM_ORGANIZATION_ID;
    delete process.env.PLATFORM_USER_ID;
    // Reset in-memory overrides between tests.
    setPlatformBaseUrl(undefined);
    setPlatformAssistantId(undefined);
    setPlatformOrganizationId(undefined);
    setPlatformUserId(undefined);
  });

  afterEach(() => {
    if (originalPlatformUrlEnv === undefined) {
      delete process.env.VELLUM_PLATFORM_URL;
    } else {
      process.env.VELLUM_PLATFORM_URL = originalPlatformUrlEnv;
    }
    if (originalOrgEnv === undefined) {
      delete process.env.PLATFORM_ORGANIZATION_ID;
    } else {
      process.env.PLATFORM_ORGANIZATION_ID = originalOrgEnv;
    }
    if (originalUserEnv === undefined) {
      delete process.env.PLATFORM_USER_ID;
    } else {
      process.env.PLATFORM_USER_ID = originalUserEnv;
    }
    setPlatformBaseUrl(undefined);
    setPlatformAssistantId(undefined);
    setPlatformOrganizationId(undefined);
    setPlatformUserId(undefined);
  });

  test("rehydrates base URL and all platform IDs from the credential store", async () => {
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] = PROD_URL;
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      ASSISTANT_ID;
    mockSecureKeys[credentialKey("vellum", "platform_organization_id")] =
      ORG_ID;
    mockSecureKeys[credentialKey("vellum", "platform_user_id")] = USER_ID;

    await rehydratePlatformCredentials();

    expect(getPlatformBaseUrl()).toBe(PROD_URL);
    expect(getPlatformAssistantId()).toBe(ASSISTANT_ID);
    expect(getPlatformOrganizationId()).toBe(ORG_ID);
    expect(getPlatformUserId()).toBe(USER_ID);
  });

  test("trims stored values before applying them", async () => {
    mockSecureKeys[credentialKey("vellum", "platform_base_url")] =
      `  ${PROD_URL}  `;
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      `\n${ASSISTANT_ID}\n`;

    await rehydratePlatformCredentials();

    expect(getPlatformBaseUrl()).toBe(PROD_URL);
    expect(getPlatformAssistantId()).toBe(ASSISTANT_ID);
  });

  test("leaves overrides untouched when nothing is stored", async () => {
    await rehydratePlatformCredentials();

    expect(getPlatformAssistantId()).toBe("");
    expect(getPlatformOrganizationId()).toBe("");
    expect(getPlatformUserId()).toBe("");
  });

  test("a per-field read failure does not block the remaining fields", async () => {
    throwForKey = credentialKey("vellum", "platform_base_url");
    mockSecureKeys[credentialKey("vellum", "platform_assistant_id")] =
      ASSISTANT_ID;

    await rehydratePlatformCredentials();

    expect(getPlatformAssistantId()).toBe(ASSISTANT_ID);
  });
});
