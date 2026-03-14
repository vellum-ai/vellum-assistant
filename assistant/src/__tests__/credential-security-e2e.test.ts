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
    blockIngress: true,
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
    listSecureKeys: () => [...storedKeys.keys()],
    getBackendType: () => "encrypted",
  };
});

// In-memory metadata store that mirrors storedKeys for list/get operations
const metadataStore = new Map<
  string,
  { credentialId: string; service: string; field: string }
>();

mock.module("../tools/credentials/metadata-store.js", () => ({
  upsertCredentialMetadata: (
    service: string,
    field: string,
    _policy?: Record<string, unknown>,
  ) => {
    const key = `${service}:${field}`;
    metadataStore.set(key, {
      credentialId: `cred-${service}-${field}`,
      service,
      field,
    });
  },
  deleteCredentialMetadata: (service: string, field: string) => {
    metadataStore.delete(`${service}:${field}`);
  },
  getCredentialMetadata: (service: string, field: string) => {
    return metadataStore.get(`${service}:${field}`) ?? null;
  },
  getCredentialMetadataById: (id: string) => {
    for (const m of metadataStore.values()) {
      if (m.credentialId === id) return m;
    }
    return undefined;
  },
  listCredentialMetadata: () => [...metadataStore.values()],
  assertMetadataWritable: () => {},
  _setMetadataPath: () => {},
}));

mock.module("../tools/credentials/policy-validate.js", () => ({
  validatePolicyInput: () => ({ valid: true, errors: [] }),
  toPolicyFromInput: (input: Record<string, unknown>) => ({
    allowedTools: input.allowed_tools ?? [],
    allowedDomains: input.allowed_domains ?? [],
    usageDescription: input.usage_description,
  }),
}));

// Import modules under test
const { credentialStoreTool } = await import("../tools/credentials/vault.js");
const { checkIngressForSecrets } =
  await import("../security/secret-ingress.js");
const { isToolAllowed } = await import("../tools/credentials/tool-policy.js");
const { isDomainAllowed } =
  await import("../tools/credentials/domain-policy.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    workingDir: "/tmp",
    sessionId: "s1",
    conversationId: "c1",
    trustClass: "guardian" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E2E Scenario 1 — Normal secure store + list
// ---------------------------------------------------------------------------

describe("E2E: secure store and list lifecycle", () => {
  beforeEach(() => {
    storedKeys.clear();
    metadataStore.clear();
  });

  test("store persists credential and returns metadata-only confirmation", async () => {
    const result = await credentialStoreTool.execute(
      {
        action: "store",
        service: "github",
        field: "token",
        value: "ghp_abc123",
      },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("github");
    // Value must NOT appear in tool output (invariant 1)
    expect(result.content).not.toContain("ghp_abc123");
    // Value must be in keychain
    expect(storedKeys.get("credential/github/token")).toBe("ghp_abc123");
  });

  test("list returns service/field pairs without secret values", async () => {
    storedKeys.set("credential/github/token", "secret1");
    storedKeys.set("credential/aws/access_key", "secret2");
    metadataStore.set("github:token", {
      credentialId: "cred-github-token",
      service: "github",
      field: "token",
    });
    metadataStore.set("aws:access_key", {
      credentialId: "cred-aws-access_key",
      service: "aws",
      field: "access_key",
    });

    const result = await credentialStoreTool.execute(
      { action: "list" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("github");
    expect(result.content).toContain("token");
    // Secret values must NOT appear
    expect(result.content).not.toContain("secret1");
    expect(result.content).not.toContain("secret2");
  });

  test("delete removes credential from keychain", async () => {
    storedKeys.set("credential/github/token", "secret1");

    const result = await credentialStoreTool.execute(
      { action: "delete", service: "github", field: "token" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(storedKeys.has("credential/github/token")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E Scenario 2 — Secret-in-chat blocked and redirected
// ---------------------------------------------------------------------------

describe("E2E: secret ingress blocking", () => {
  beforeEach(() => {
    mockConfig.secretDetection.enabled = true;
    mockConfig.secretDetection.action = "block";
  });

  test("blocks message containing AWS access key", () => {
    const awsKey = ["AKIA", "IOSFODNN7", "REALKEY"].join("");
    const check = checkIngressForSecrets(`Here is my key: ${awsKey}`);
    expect(check.blocked).toBe(true);
    expect(check.detectedTypes.length).toBeGreaterThan(0);
    // Notice must never contain the actual secret
    expect(check.userNotice).toBeDefined();
    expect(check.userNotice).not.toContain(awsKey);
  });

  test("blocks message containing GitHub token", () => {
    const ghToken = ["ghp_", "ABCDEFghijklMN01234567", "89abcdef"].join("");
    const check = checkIngressForSecrets(`Use this token: ${ghToken}`);
    expect(check.blocked).toBe(true);
  });

  test("allows normal text through", () => {
    const check = checkIngressForSecrets("Please help me configure my project");
    expect(check.blocked).toBe(false);
    expect(check.detectedTypes).toEqual([]);
  });

  test("bypasses when detection is disabled", () => {
    mockConfig.secretDetection.enabled = false;
    const awsKey = ["AKIA", "IOSFODNN7", "REALKEY"].join("");
    const check = checkIngressForSecrets(awsKey);
    expect(check.blocked).toBe(false);
  });

  test("bypasses when blockIngress is false", () => {
    mockConfig.secretDetection.blockIngress = false;
    const awsKey = ["AKIA", "IOSFODNN7", "REALKEY"].join("");
    const check = checkIngressForSecrets(awsKey);
    expect(check.blocked).toBe(false);
  });

  test("still blocks when action is warn but blockIngress is true", () => {
    mockConfig.secretDetection.action = "warn";
    mockConfig.secretDetection.blockIngress = true;
    const awsKey = ["AKIA", "IOSFODNN7", "REALKEY"].join("");
    const check = checkIngressForSecrets(awsKey);
    expect(check.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E Scenario 3 — One-time send override path
// ---------------------------------------------------------------------------

describe("E2E: one-time send override", () => {
  beforeEach(() => {
    storedKeys.clear();
    metadataStore.clear();
    mockConfig.secretDetection.allowOneTimeSend = false;
  });

  test("rejects transient_send when config gate is off", async () => {
    const ctx = makeContext({
      requestSecret: async () => ({
        value: "tmp1",
        delivery: "transient_send" as const,
      }),
    });
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not enabled");
    expect(storedKeys.has("credential/svc/key")).toBe(false);
  });

  test("accepts transient_send when config gate is on", async () => {
    mockConfig.secretDetection.allowOneTimeSend = true;
    const ctx = makeContext({
      requestSecret: async () => ({
        value: "tmp1",
        delivery: "transient_send" as const,
      }),
    });
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("NOT saved");
    // Value must NOT be in keychain
    expect(storedKeys.has("credential/svc/key")).toBe(false);
    // Value must NOT appear in output
    expect(result.content).not.toContain("tmp1");
  });

  test("store delivery always persists regardless of config gate", async () => {
    mockConfig.secretDetection.allowOneTimeSend = true;
    const ctx = makeContext({
      requestSecret: async () => ({
        value: "perm1",
        delivery: "store" as const,
      }),
    });
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(storedKeys.has("credential/svc/key")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E Scenario 4 — Tool policy enforcement
// ---------------------------------------------------------------------------

describe("E2E: tool policy enforcement", () => {
  test("allows tool when listed in allowedTools", () => {
    expect(
      isToolAllowed("browser_fill_credential", ["browser_fill_credential"]),
    ).toBe(true);
  });

  test("denies tool when not listed", () => {
    expect(isToolAllowed("browser_fill_credential", ["other_tool"])).toBe(
      false,
    );
  });

  test("denies all tools when allowedTools is empty (fail-closed)", () => {
    expect(isToolAllowed("browser_fill_credential", [])).toBe(false);
  });

  test("denies when toolName is empty", () => {
    expect(isToolAllowed("", ["browser_fill_credential"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E Scenario 5 — Domain policy enforcement
// ---------------------------------------------------------------------------

describe("E2E: domain policy enforcement", () => {
  test("allows exact domain match", () => {
    expect(isDomainAllowed("github.com", ["github.com"])).toBe(true);
  });

  test("allows subdomain of registrable domain", () => {
    expect(isDomainAllowed("login.github.com", ["github.com"])).toBe(true);
  });

  test("denies mismatched domain", () => {
    expect(isDomainAllowed("evil.com", ["github.com"])).toBe(false);
  });

  test("denies when allowedDomains is empty (fail-closed)", () => {
    expect(isDomainAllowed("github.com", [])).toBe(false);
  });

  test("denies localhost and IP addresses", () => {
    expect(isDomainAllowed("localhost", ["localhost"])).toBe(false);
    expect(isDomainAllowed("127.0.0.1", ["127.0.0.1"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting — output never leaks secrets
// ---------------------------------------------------------------------------

describe("E2E: cross-cutting secret leak prevention", () => {
  beforeEach(() => {
    storedKeys.clear();
    mockConfig.secretDetection.enabled = true;
    mockConfig.secretDetection.action = "block";
    mockConfig.secretDetection.allowOneTimeSend = false;
  });

  test("store output never contains the stored value", async () => {
    const secret = ["sk", "-proj-", "abc123xyz"].join("");
    const result = await credentialStoreTool.execute(
      { action: "store", service: "openai", field: "api_key", value: secret },
      makeContext(),
    );
    expect(result.content).not.toContain(secret);
  });

  test("prompt output never contains the secret value", async () => {
    mockConfig.secretDetection.allowOneTimeSend = true;
    const secret = ["tok", "_", "sensitive99"].join("");
    const ctx = makeContext({
      requestSecret: async () => ({
        value: secret,
        delivery: "transient_send" as const,
      }),
    });
    const result = await credentialStoreTool.execute(
      { action: "prompt", service: "svc", field: "key", label: "Key" },
      ctx,
    );
    expect(result.content).not.toContain(secret);
  });

  test("ingress notice never contains the detected secret", () => {
    const awsKey = ["AKIA", "IOSFODNN7", "REALKEY"].join("");
    const check = checkIngressForSecrets(awsKey);
    expect(check.blocked).toBe(true);
    expect(check.userNotice).toBeDefined();
    expect(check.userNotice).not.toContain(awsKey);
  });
});
