import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing modules under test
// ---------------------------------------------------------------------------

const mockConfig = {
  secretDetection: {
    enabled: true,
    action: "block" as "redact" | "warn" | "block",
    entropyThreshold: 4.0,
    allowOneTimeSend: false,
  },
  timeouts: { permissionTimeoutSec: 300 },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track keychain writes
const storedKeys = new Map<string, string>();
mock.module("../security/secure-keys.js", () => {
  const syncSet = (key: string, value: string) => {
    storedKeys.set(key, value);
    return true;
  };
  const syncDelete = (key: string) => {
    if (storedKeys.has(key)) {
      storedKeys.delete(key);
      return "deleted" as const;
    }
    return "not-found" as const;
  };
  return {
    getSecureKeyAsync: async (key: string) => storedKeys.get(key) ?? undefined,
    setSecureKeyAsync: async (key: string, value: string) =>
      syncSet(key, value),
    deleteSecureKeyAsync: async (key: string) => syncDelete(key),
    listSecureKeysAsync: async () => [],
  };
});

mock.module("./metadata-store.js", () => ({
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  getCredentialMetadata: () => null,
}));

mock.module("./policy-validate.js", () => ({
  validatePolicyInput: () => ({ valid: true, errors: [] }),
  toPolicyFromInput: () => ({
    allowedTools: [],
    allowedDomains: [],
    usageDescription: undefined,
  }),
}));

import { credentialKey } from "../security/credential-key.js";

const { credentialStoreTool } = await import("../tools/credentials/vault.js");

describe("one-time send override", () => {
  beforeEach(() => {
    storedKeys.clear();
    mockConfig.secretDetection.allowOneTimeSend = false;
  });

  test("transient_send is rejected when allowOneTimeSend is disabled", async () => {
    const context = {
      workingDir: "/tmp",
      sessionId: "s1",
      conversationId: "c1",
      trustClass: "guardian" as const,
      requestSecret: async () => ({
        value: "v1",
        delivery: "transient_send" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not enabled");
    // Value must NOT be stored in keychain
    expect(storedKeys.has(credentialKey("svc", "key"))).toBe(false);
  });

  test("transient_send succeeds when allowOneTimeSend is enabled", async () => {
    mockConfig.secretDetection.allowOneTimeSend = true;
    const context = {
      workingDir: "/tmp",
      sessionId: "s1",
      conversationId: "c1",
      trustClass: "guardian" as const,
      requestSecret: async () => ({
        value: "v1",
        delivery: "transient_send" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("NOT saved");
    // Value must NOT be stored in keychain
    expect(storedKeys.has(credentialKey("svc", "key"))).toBe(false);
  });

  test("store delivery always persists to keychain regardless of allowOneTimeSend", async () => {
    mockConfig.secretDetection.allowOneTimeSend = true;
    const context = {
      workingDir: "/tmp",
      sessionId: "s1",
      conversationId: "c1",
      trustClass: "guardian" as const,
      requestSecret: async () => ({ value: "v1", delivery: "store" as const }),
    };

    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("stored");
    expect(storedKeys.has(credentialKey("svc", "key"))).toBe(true);
  });

  test("transient_send response content never contains the secret value", async () => {
    mockConfig.secretDetection.allowOneTimeSend = true;
    const secretVal = ["nv", "sh", "1"].join("");
    const context = {
      workingDir: "/tmp",
      sessionId: "s1",
      conversationId: "c1",
      trustClass: "guardian" as const,
      requestSecret: async () => ({
        value: secretVal,
        delivery: "transient_send" as const,
      }),
    };

    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      context,
    );
    expect(result.content).not.toContain(secretVal);
  });
});
