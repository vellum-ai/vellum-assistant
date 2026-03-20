import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { credentialKey } from "../security/credential-key.js";
import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";

// ---------------------------------------------------------------------------
// In-memory mock state
// ---------------------------------------------------------------------------

let secureKeyStore = new Map<string, string>();
let metadataStore: CredentialMetadata[] = [];
let idCounter = 0;
let mockBrokerUnreachable = false;

function nextUUID(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Mock secure-keys
// ---------------------------------------------------------------------------

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: async (
    account: string,
    value: string,
  ): Promise<boolean> => {
    secureKeyStore.set(account, value);
    return true;
  },
  deleteSecureKeyAsync: async (
    account: string,
  ): Promise<"deleted" | "not-found" | "error"> => {
    if (secureKeyStore.has(account)) {
      secureKeyStore.delete(account);
      return "deleted";
    }
    return "not-found";
  },
  listSecureKeysAsync: async (): Promise<string[]> => {
    return [...secureKeyStore.keys()];
  },
  getSecureKeyAsync: async (account: string): Promise<string | undefined> => {
    return secureKeyStore.get(account);
  },
  getSecureKeyResultAsync: async (
    account: string,
  ): Promise<{ value: string | undefined; unreachable: boolean }> => ({
    value: secureKeyStore.get(account),
    unreachable: mockBrokerUnreachable,
  }),
  _resetBackend: (): void => {},
}));

// ---------------------------------------------------------------------------
// Mock metadata-store
// ---------------------------------------------------------------------------

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: (): void => {},
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: {
      allowedTools?: string[];
      allowedDomains?: string[];
      usageDescription?: string;
      expiresAt?: number | null;
      grantedScopes?: string[];
      alias?: string | null;
      injectionTemplates?: unknown[] | null;
    },
  ): CredentialMetadata => {
    const now = Date.now();
    const existing = metadataStore.find(
      (c) => c.service === service && c.field === field,
    );

    if (existing) {
      if (policy?.allowedTools !== undefined)
        existing.allowedTools = policy.allowedTools;
      if (policy?.allowedDomains !== undefined)
        existing.allowedDomains = policy.allowedDomains;
      if (policy?.usageDescription !== undefined)
        existing.usageDescription = policy.usageDescription;
      if (policy?.alias !== undefined) {
        if (policy.alias == null) {
          delete existing.alias;
        } else {
          existing.alias = policy.alias;
        }
      }
      existing.updatedAt = now;
      return existing;
    }

    const record: CredentialMetadata = {
      credentialId: nextUUID(),
      service,
      field,
      allowedTools: policy?.allowedTools ?? [],
      allowedDomains: policy?.allowedDomains ?? [],
      usageDescription: policy?.usageDescription,
      alias: policy?.alias ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    metadataStore.push(record);
    return record;
  },
  getCredentialMetadata: (
    service: string,
    field: string,
  ): CredentialMetadata | undefined => {
    return metadataStore.find(
      (c) => c.service === service && c.field === field,
    );
  },
  getCredentialMetadataById: (
    credentialId: string,
  ): CredentialMetadata | undefined => {
    return metadataStore.find((c) => c.credentialId === credentialId);
  },
  deleteCredentialMetadata: (service: string, field: string): boolean => {
    const idx = metadataStore.findIndex(
      (c) => c.service === service && c.field === field,
    );
    if (idx === -1) return false;
    metadataStore.splice(idx, 1);
    return true;
  },
  listCredentialMetadata: (): CredentialMetadata[] => {
    return [...metadataStore];
  },
}));

// ---------------------------------------------------------------------------
// Mock oauth-store
// ---------------------------------------------------------------------------

let disconnectOAuthProviderCalls: string[] = [];
let disconnectOAuthProviderResult: "disconnected" | "not-found" | "error" =
  "not-found";

mock.module("../oauth/oauth-store.js", () => ({
  disconnectOAuthProvider: async (
    providerKey: string,
  ): Promise<"disconnected" | "not-found" | "error"> => {
    disconnectOAuthProviderCalls.push(providerKey);
    return disconnectOAuthProviderResult;
  },
  getConnectionByProvider: (): undefined => undefined,
  listConnections: (): never[] => [],
  deleteConnection: (): boolean => false,
  upsertApp: async () => ({ id: "mock-app-id" }),
  createConnection: () => ({ id: "mock-conn-id" }),
  updateConnection: (): boolean => true,
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerCredentialsCommand } =
  await import("../cli/commands/credentials.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  // Suppress stderr so Commander error messages don't leak to test runner
  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerCredentialsCommand(program);
    await program.parseAsync(["node", "vellum", "credentials", ...args]);
  } catch {
    // Commander throws on --help and on missing required args; treat as non-zero exit
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

/**
 * Pre-populate mock stores with a credential.
 */
function seedCredential(
  service: string,
  field: string,
  secret: string,
  extra?: Partial<CredentialMetadata>,
): CredentialMetadata {
  const now = Date.now();
  const record: CredentialMetadata = {
    credentialId: nextUUID(),
    service,
    field,
    allowedTools: [],
    allowedDomains: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  metadataStore.push(record);
  secureKeyStore.set(credentialKey(service, field), secret);
  return record;
}

/**
 * Pre-populate mock stores with metadata only (no secret).
 */
function seedMetadataOnly(
  service: string,
  field: string,
  extra?: Partial<CredentialMetadata>,
): CredentialMetadata {
  const now = Date.now();
  const record: CredentialMetadata = {
    credentialId: nextUUID(),
    service,
    field,
    allowedTools: [],
    allowedDomains: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  metadataStore.push(record);
  return record;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant credentials CLI", () => {
  beforeEach(() => {
    secureKeyStore = new Map();
    metadataStore = [];
    idCounter = 0;
    mockBrokerUnreachable = false;
    disconnectOAuthProviderCalls = [];
    disconnectOAuthProviderResult = "not-found";
    process.exitCode = 0;
  });

  // =========================================================================
  // list
  // =========================================================================

  describe("list", () => {
    test("returns empty array when no credentials exist", async () => {
      const result = await runCli(["list", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        credentials: [],
        managedCredentials: [],
      });
    });

    test("returns all credentials with correct shapes", async () => {
      seedCredential("twilio", "account_sid", "AC12345678abcdefgh");
      seedCredential("twilio", "auth_token", "auth_secret_val");
      seedCredential("github", "token", "ghp_abcdefghij1234");

      const result = await runCli(["list", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.credentials).toHaveLength(3);

      for (const cred of parsed.credentials) {
        expect(cred).toHaveProperty("ok", true);
        expect(cred).toHaveProperty("service");
        expect(cred).toHaveProperty("field");
        expect(cred).toHaveProperty("credentialId");
        expect(cred).toHaveProperty("scrubbedValue");
        expect(cred).toHaveProperty("hasSecret");
        expect(cred).toHaveProperty("alias");
        expect(cred).toHaveProperty("usageDescription");
        expect(cred).toHaveProperty("allowedTools");
        expect(cred).toHaveProperty("allowedDomains");
        expect(cred).toHaveProperty("grantedScopes");
        expect(cred).toHaveProperty("expiresAt");
        expect(cred).toHaveProperty("createdAt");
        expect(cred).toHaveProperty("updatedAt");
        expect(cred).toHaveProperty("injectionTemplateCount");
      }
    });

    test("filters by --search matching service name", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");
      seedCredential("twilio", "auth_token", "auth_secret_1234");
      seedCredential("github", "token", "ghp_abcdefghij");

      const result = await runCli(["list", "--search", "twilio", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.credentials).toHaveLength(2);
      expect(parsed.credentials[0].service).toBe("twilio");
      expect(parsed.credentials[1].service).toBe("twilio");
    });

    test("filters by --search matching alias/label", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012", {
        alias: "prod",
      });
      seedCredential("github", "token", "ghp_abcdefghij");

      const result = await runCli(["list", "--search", "prod", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.credentials).toHaveLength(1);
      expect(parsed.credentials[0].service).toBe("twilio");
      expect(parsed.credentials[0].alias).toBe("prod");
    });

    test("filters by --search matching field name", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");
      seedCredential("slack", "bot_token", "xoxb-1234567890");
      seedCredential("github", "token", "ghp_abcdefghij");

      const result = await runCli(["list", "--search", "bot_token", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.credentials).toHaveLength(1);
      expect(parsed.credentials[0].field).toBe("bot_token");
    });

    test("filters by --search matching description", async () => {
      seedCredential("fal", "api_key", "key_live_abc123456", {
        usageDescription: "Image generation",
      });
      seedCredential("github", "token", "ghp_abcdefghij");

      const result = await runCli(["list", "--search", "image", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.credentials).toHaveLength(1);
      expect(parsed.credentials[0].service).toBe("fal");
      expect(parsed.credentials[0].usageDescription).toBe("Image generation");
    });

    test("returns empty array when --search has no matches", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");
      seedCredential("github", "token", "ghp_abcdefghij");

      const result = await runCli([
        "list",
        "--search",
        "nonexistent",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        credentials: [],
        managedCredentials: [],
      });
    });

    test("list items have the same shape as inspect output", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");

      const listResult = await runCli(["list", "--json"]);
      const listParsed = JSON.parse(listResult.stdout);
      const listItem = listParsed.credentials[0];

      const inspectResult = await runCli([
        "inspect",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "--json",
      ]);
      const inspectParsed = JSON.parse(inspectResult.stdout);

      const listKeys = Object.keys(listItem).sort();
      const inspectKeys = Object.keys(inspectParsed).sort();
      expect(listKeys).toEqual(inspectKeys);
    });
  });

  // =========================================================================
  // set
  // =========================================================================

  describe("set", () => {
    test("stores secret and creates metadata", async () => {
      const result = await runCli([
        "set",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "AC1234567890",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe("twilio");
      expect(parsed.field).toBe("account_sid");
      expect(parsed.credentialId).toBeTruthy();

      // Verify secret stored in mock map
      expect(secureKeyStore.get(credentialKey("twilio", "account_sid"))).toBe(
        "AC1234567890",
      );

      // Verify metadata created
      const meta = metadataStore.find(
        (m) => m.service === "twilio" && m.field === "account_sid",
      );
      expect(meta).toBeTruthy();
      expect(meta!.service).toBe("twilio");
      expect(meta!.field).toBe("account_sid");
    });

    test("stores metadata with --label and --description", async () => {
      const result = await runCli([
        "set",
        "--service",
        "fal",
        "--field",
        "api_key",
        "key_live_abc",
        "--label",
        "fal-prod",
        "--description",
        "Image generation",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);

      const meta = metadataStore.find(
        (m) => m.service === "fal" && m.field === "api_key",
      );
      expect(meta).toBeTruthy();
      expect(meta!.alias).toBe("fal-prod");
      expect(meta!.usageDescription).toBe("Image generation");
    });

    test("errors when --service flag is missing", async () => {
      const result = await runCli([
        "set",
        "--field",
        "account_sid",
        "some_value",
        "--json",
      ]);
      // Commander should error on missing required option
      expect(result.exitCode).not.toBe(0);
    });

    test("errors when --field flag is missing", async () => {
      const result = await runCli([
        "set",
        "--service",
        "twilio",
        "some_value",
        "--json",
      ]);
      // Commander should error on missing required option
      expect(result.exitCode).not.toBe(0);
    });

    test("errors when value argument is missing", async () => {
      const result = await runCli([
        "set",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "--json",
      ]);
      // Commander should error on missing required arg
      expect(result.exitCode).not.toBe(0);
    });

    test("stores metadata with --allowed-tools", async () => {
      const result = await runCli([
        "set",
        "--service",
        "twilio",
        "--field",
        "auth_token",
        "sometoken",
        "--allowed-tools",
        "bash,host_bash",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);

      const meta = metadataStore.find(
        (m) => m.service === "twilio" && m.field === "auth_token",
      );
      expect(meta).toBeTruthy();
      expect(meta!.allowedTools).toEqual(["bash", "host_bash"]);
    });

    test("updates existing credential on second set", async () => {
      // First set
      await runCli([
        "set",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "original_value",
        "--json",
      ]);
      const meta1 = metadataStore.find(
        (m) => m.service === "twilio" && m.field === "account_sid",
      );
      expect(meta1).toBeTruthy();
      const firstUpdatedAt = meta1!.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Second set
      await runCli([
        "set",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "new_value",
        "--json",
      ]);
      const meta2 = metadataStore.find(
        (m) => m.service === "twilio" && m.field === "account_sid",
      );
      expect(meta2).toBeTruthy();
      expect(meta2!.updatedAt).toBeGreaterThan(firstUpdatedAt);

      // Verify secret is overwritten
      expect(secureKeyStore.get(credentialKey("twilio", "account_sid"))).toBe(
        "new_value",
      );
    });
  });

  // =========================================================================
  // delete
  // =========================================================================

  describe("delete", () => {
    test("removes both secret and metadata", async () => {
      seedCredential("twilio", "auth_token", "secret_value_here");

      const result = await runCli([
        "delete",
        "--service",
        "twilio",
        "--field",
        "auth_token",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe("twilio");
      expect(parsed.field).toBe("auth_token");

      // Verify both removed
      expect(secureKeyStore.has(credentialKey("twilio", "auth_token"))).toBe(
        false,
      );
      expect(
        metadataStore.find(
          (m) => m.service === "twilio" && m.field === "auth_token",
        ),
      ).toBeUndefined();
    });

    test("errors on nonexistent credential", async () => {
      const result = await runCli([
        "delete",
        "--service",
        "twilio",
        "--field",
        "nonexistent",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("errors when --service flag is missing", async () => {
      const result = await runCli([
        "delete",
        "--field",
        "auth_token",
        "--json",
      ]);
      // Commander should error on missing required option
      expect(result.exitCode).not.toBe(0);
    });

    test("errors when --field flag is missing", async () => {
      const result = await runCli(["delete", "--service", "twilio", "--json"]);
      // Commander should error on missing required option
      expect(result.exitCode).not.toBe(0);
    });

    test("succeeds when only metadata exists (no secret)", async () => {
      seedMetadataOnly("twilio", "auth_token");

      const result = await runCli([
        "delete",
        "--service",
        "twilio",
        "--field",
        "auth_token",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);

      // Verify metadata removed
      expect(
        metadataStore.find(
          (m) => m.service === "twilio" && m.field === "auth_token",
        ),
      ).toBeUndefined();
    });

    test("calls disconnectOAuthProvider for OAuth cleanup", async () => {
      seedCredential("gmail", "access_token", "ya29.token_value");

      const result = await runCli([
        "delete",
        "--service",
        "gmail",
        "--field",
        "access_token",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);

      // disconnectOAuthProvider should have been called with the service name
      expect(disconnectOAuthProviderCalls).toEqual(["gmail"]);
    });

    test("succeeds when only OAuth connection exists (no legacy credential)", async () => {
      // No legacy credential seeded — only the OAuth disconnect finds something
      disconnectOAuthProviderResult = "disconnected";

      const result = await runCli([
        "delete",
        "--service",
        "gmail",
        "--field",
        "access_token",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe("gmail");
      expect(parsed.field).toBe("access_token");

      expect(disconnectOAuthProviderCalls).toEqual(["gmail"]);
    });
  });

  // =========================================================================
  // inspect
  // =========================================================================

  describe("inspect", () => {
    test("shows metadata and scrubbed value by --service/--field", async () => {
      const meta = seedCredential("twilio", "account_sid", "AC123456789012");

      const result = await runCli([
        "inspect",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe("twilio");
      expect(parsed.field).toBe("account_sid");
      expect(parsed.credentialId).toBe(meta.credentialId);
      expect(parsed.scrubbedValue).toBe("****9012");
      expect(parsed.hasSecret).toBe(true);
      expect(parsed.createdAt).toBe(new Date(meta.createdAt).toISOString());
      expect(parsed.updatedAt).toBe(new Date(meta.updatedAt).toISOString());
      expect(parsed).toHaveProperty("alias");
      expect(parsed).toHaveProperty("usageDescription");
      expect(parsed).toHaveProperty("allowedTools");
      expect(parsed).toHaveProperty("allowedDomains");
      expect(parsed).toHaveProperty("grantedScopes");
      expect(parsed).toHaveProperty("expiresAt");
      expect(parsed).toHaveProperty("injectionTemplateCount");
    });

    test("looks up credential by UUID", async () => {
      const meta = seedCredential("github", "token", "ghp_abcdefghij1234");

      const result = await runCli(["inspect", meta.credentialId, "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe("github");
      expect(parsed.field).toBe("token");
      expect(parsed.credentialId).toBe(meta.credentialId);
    });

    test("scrubs normal-length secret (>4 chars): shows last 4", async () => {
      seedCredential("test", "normal", "abcdefgh");

      const result = await runCli([
        "inspect",
        "--service",
        "test",
        "--field",
        "normal",
        "--json",
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.scrubbedValue).toBe("****efgh");
    });

    test("scrubs short secret (<=4 chars): shows only ****", async () => {
      seedCredential("test", "short", "ab");

      const result = await runCli([
        "inspect",
        "--service",
        "test",
        "--field",
        "short",
        "--json",
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.scrubbedValue).toBe("****");
    });

    test("shows (not set) when no secret exists", async () => {
      seedMetadataOnly("test", "nosecret");

      const result = await runCli([
        "inspect",
        "--service",
        "test",
        "--field",
        "nosecret",
        "--json",
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.scrubbedValue).toBe("(not set)");
      expect(parsed.hasSecret).toBe(false);
    });

    test("errors when neither flags nor UUID provided", async () => {
      const result = await runCli(["inspect", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("--service");
    });

    test("errors on nonexistent credential by --service/--field", async () => {
      const result = await runCli([
        "inspect",
        "--service",
        "nonexistent",
        "--field",
        "field",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("errors on nonexistent UUID", async () => {
      const result = await runCli([
        "inspect",
        "00000000-0000-0000-0000-000000000099",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("--json flag produces compact JSON (single line)", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");

      const result = await runCli([
        "inspect",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "--json",
      ]);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      // Verify it parses as valid JSON
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    test("shows hasSecret: false when metadata exists but no secret", async () => {
      seedMetadataOnly("test", "metaonly");

      const result = await runCli([
        "inspect",
        "--service",
        "test",
        "--field",
        "metaonly",
        "--json",
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.hasSecret).toBe(false);
      expect(parsed.scrubbedValue).toBe("(not set)");
    });

    test("shows broker unreachable when metadata exists but broker is down", async () => {
      seedMetadataOnly("twilio", "account_sid");
      mockBrokerUnreachable = true;

      const result = await runCli([
        "inspect",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.scrubbedValue).toBe("(broker unreachable)");
      expect(parsed.brokerUnreachable).toBe(true);
    });

    test("shows unreachable error when no metadata and broker is down", async () => {
      mockBrokerUnreachable = true;

      const result = await runCli([
        "inspect",
        "--service",
        "nonexistent",
        "--field",
        "field",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Keychain broker is unreachable");
    });
  });

  // =========================================================================
  // reveal
  // =========================================================================

  describe("reveal", () => {
    test("returns plaintext value by --service/--field", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");

      const result = await runCli([
        "reveal",
        "--service",
        "twilio",
        "--field",
        "account_sid",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toBe("AC123456789012");
    });

    test("returns plaintext value by UUID", async () => {
      const meta = seedCredential("github", "token", "ghp_abcdefghij1234");

      const result = await runCli(["reveal", meta.credentialId, "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toBe("ghp_abcdefghij1234");
    });

    test("errors on nonexistent credential by --service/--field", async () => {
      const result = await runCli([
        "reveal",
        "--service",
        "nonexistent",
        "--field",
        "field",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("errors on nonexistent UUID", async () => {
      const result = await runCli([
        "reveal",
        "00000000-0000-0000-0000-000000000099",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("errors when neither flags nor UUID provided", async () => {
      const result = await runCli(["reveal", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("--service");
    });

    test("reveal in human mode emits bare secret with trailing newline", async () => {
      seedCredential("twilio", "auth_token", "secret_xyz_789");

      const result = await runCli([
        "reveal",
        "--service",
        "twilio",
        "--field",
        "auth_token",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("secret_xyz_789\n");
    });

    test("errors when metadata exists but no secret stored", async () => {
      seedMetadataOnly("test", "nosecret");

      const result = await runCli([
        "reveal",
        "--service",
        "test",
        "--field",
        "nosecret",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("returns unreachable error when broker is down", async () => {
      mockBrokerUnreachable = true;

      const result = await runCli([
        "reveal",
        "--service",
        "twilio",
        "--field",
        "auth_token",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Keychain broker is unreachable");
    });

    test("returns credential-not-found when broker is up", async () => {
      mockBrokerUnreachable = false;

      const result = await runCli([
        "reveal",
        "--service",
        "twilio",
        "--field",
        "nonexistent",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe("Credential not found");
    });
  });

  // =========================================================================
  // compound service names (colons in service)
  // =========================================================================

  describe("compound service names", () => {
    test("set and reveal with colon in service name works correctly", async () => {
      const setResult = await runCli([
        "set",
        "--service",
        "integration:google",
        "--field",
        "client_secret",
        "secret123",
        "--json",
      ]);
      expect(setResult.exitCode).toBe(0);
      const setParsed = JSON.parse(setResult.stdout);
      expect(setParsed.ok).toBe(true);
      expect(setParsed.service).toBe("integration:google");
      expect(setParsed.field).toBe("client_secret");

      const revealResult = await runCli([
        "reveal",
        "--service",
        "integration:google",
        "--field",
        "client_secret",
        "--json",
      ]);
      expect(revealResult.exitCode).toBe(0);
      const revealParsed = JSON.parse(revealResult.stdout);
      expect(revealParsed.ok).toBe(true);
      expect(revealParsed.value).toBe("secret123");
    });
  });

  // =========================================================================
  // instance-scoped BASE_DATA_DIR
  // =========================================================================

  describe("instance-scoped BASE_DATA_DIR", () => {
    let savedBaseDataDir: string | undefined;

    beforeEach(() => {
      savedBaseDataDir = process.env.BASE_DATA_DIR;
    });

    afterEach(() => {
      if (savedBaseDataDir === undefined) {
        delete process.env.BASE_DATA_DIR;
      } else {
        process.env.BASE_DATA_DIR = savedBaseDataDir;
      }
    });

    test("credential reveal reads from instance-scoped store when BASE_DATA_DIR is set", async () => {
      // Point BASE_DATA_DIR to a temp directory (simulating instance-scoped dir)
      const tmpDir = (await import("node:os")).tmpdir();
      const instanceDir = (await import("node:path")).join(
        tmpDir,
        `vellum-test-instance-${Date.now()}`,
      );
      process.env.BASE_DATA_DIR = instanceDir;

      // Seed a credential in the mock store
      seedCredential("twilio", "auth_token", "instance_secret_abc123");

      // Run `credentials reveal --service twilio --field auth_token`
      const result = await runCli([
        "reveal",
        "--service",
        "twilio",
        "--field",
        "auth_token",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toBe("instance_secret_abc123");

      // Verify the correct key was looked up in the secure store
      expect(secureKeyStore.has(credentialKey("twilio", "auth_token"))).toBe(
        true,
      );
      expect(secureKeyStore.get(credentialKey("twilio", "auth_token"))).toBe(
        "instance_secret_abc123",
      );
    });
  });

  // =========================================================================
  // help text quality
  // =========================================================================

  describe("help text", () => {
    test("credentials --help contains naming convention table and storage description", async () => {
      const result = await runCli(["--help"]);
      const out = result.stdout;
      expect(out).toContain("--service twilio --field account_sid");
      expect(out).toContain("AES-256-GCM");
      expect(out).toContain("Examples:");
    });

    test("credentials list --help contains --search description and examples", async () => {
      const result = await runCli(["list", "--help"]);
      const out = result.stdout;
      expect(out).toContain("--search");
      expect(out).toContain("Examples:");
      expect(out).toContain("credentials list --search twilio");
    });

    test("credentials set --help contains Arguments: and Examples: sections", async () => {
      const result = await runCli(["set", "--help"]);
      const out = result.stdout;
      expect(out).toContain("Arguments:");
      expect(out).toContain("Examples:");
    });

    test("credentials inspect --help mentions UUID support", async () => {
      const result = await runCli(["inspect", "--help"]);
      const out = result.stdout;
      expect(out).toContain("UUID");
    });

    test("credentials reveal --help mentions piping and examples", async () => {
      const result = await runCli(["reveal", "--help"]);
      const out = result.stdout;
      expect(out).toContain("stdout");
      expect(out).toContain("Examples:");
    });
  });
});
