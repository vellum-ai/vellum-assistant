import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let secureKeyStore: Record<string, string> = {};

// Track metadata upsert calls to verify policy
let lastUpsertCall: {
  service: string;
  field: string;
  policy: Record<string, unknown> | undefined;
} | null = null;
let metadataDeleted: { service: string; field: string } | null = null;

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) =>
    secureKeyStore[account] ?? undefined,
  setSecureKeyAsync: async (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  },
  deleteSecureKeyAsync: async (account: string) => {
    if (account in secureKeyStore) {
      delete secureKeyStore[account];
      return "deleted" as const;
    }
    return "not-found" as const;
  },
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  deleteCredentialMetadata: (service: string, field: string) => {
    metadataDeleted = { service, field };
    return true;
  },
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: Record<string, unknown>,
  ) => {
    lastUpsertCall = { service, field, policy };
    return {};
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  deleteVercelConfig,
  getVercelConfig,
  setVercelConfig,
} from "../daemon/handlers/config-vercel.js";

describe("Vercel config handler", () => {
  beforeEach(() => {
    secureKeyStore = {};
    lastUpsertCall = null;
    metadataDeleted = null;
  });

  // -- setVercelConfig --

  describe("setVercelConfig", () => {
    test("stores token and returns success", async () => {
      const result = await setVercelConfig("vl_test_token_123");

      expect(result.success).toBe(true);
      expect(result.hasToken).toBe(true);
      expect(secureKeyStore[credentialKey("vercel", "api_token")]).toBe(
        "vl_test_token_123",
      );
    });

    test("metadata does not include bash in allowedTools", async () => {
      await setVercelConfig("vl_test_token_123");

      expect(lastUpsertCall).not.toBeNull();
      const tools = lastUpsertCall!.policy?.allowedTools as string[];
      expect(tools).not.toContain("bash");
    });

    test("metadata does not include deploy in allowedTools", async () => {
      await setVercelConfig("vl_test_token_123");

      expect(lastUpsertCall).not.toBeNull();
      const tools = lastUpsertCall!.policy?.allowedTools as string[];
      expect(tools).not.toContain("deploy");
    });

    test("metadata explicitly clears injection templates", async () => {
      await setVercelConfig("vl_test_token_123");

      expect(lastUpsertCall).not.toBeNull();
      expect(lastUpsertCall!.policy?.injectionTemplates).toBeNull();
    });

    test("publish_page and unpublish_page remain in allowedTools", async () => {
      await setVercelConfig("vl_test_token_123");

      expect(lastUpsertCall).not.toBeNull();
      const tools = lastUpsertCall!.policy?.allowedTools as string[];
      expect(tools).toContain("publish_page");
      expect(tools).toContain("unpublish_page");
    });

    test("allowedTools contains only publish_page and unpublish_page", async () => {
      await setVercelConfig("vl_test_token_123");

      expect(lastUpsertCall).not.toBeNull();
      const tools = lastUpsertCall!.policy?.allowedTools as string[];
      expect(tools).toEqual(["publish_page", "unpublish_page"]);
    });

    test("returns error when apiToken is not provided", async () => {
      const result = await setVercelConfig(undefined);

      expect(result.success).toBe(false);
      expect(result.hasToken).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // -- getVercelConfig --

  describe("getVercelConfig", () => {
    test("returns hasToken true when token exists", async () => {
      secureKeyStore[credentialKey("vercel", "api_token")] = "some-token";
      const result = await getVercelConfig();

      expect(result.hasToken).toBe(true);
      expect(result.success).toBe(true);
    });

    test("returns hasToken false when no token exists", async () => {
      const result = await getVercelConfig();

      expect(result.hasToken).toBe(false);
      expect(result.success).toBe(true);
    });
  });

  // -- deleteVercelConfig --

  describe("deleteVercelConfig", () => {
    test("removes both secure key and metadata", async () => {
      secureKeyStore[credentialKey("vercel", "api_token")] = "token-to-delete";

      const result = await deleteVercelConfig();

      expect(result.success).toBe(true);
      expect(result.hasToken).toBe(false);
      // Secure key should be removed
      expect(
        secureKeyStore[credentialKey("vercel", "api_token")],
      ).toBeUndefined();
      // Metadata should be deleted
      expect(metadataDeleted).toEqual({
        service: "vercel",
        field: "api_token",
      });
    });
  });
});
