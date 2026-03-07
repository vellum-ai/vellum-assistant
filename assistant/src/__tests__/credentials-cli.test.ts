import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";

// ---------------------------------------------------------------------------
// In-memory mock state
// ---------------------------------------------------------------------------

let secureKeyStore = new Map<string, string>();
let metadataStore: CredentialMetadata[] = [];
let idCounter = 0;

function nextUUID(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

// Track mock call counts
let _getSecureKeyCalls = 0;
let _setSecureKeyCalls = 0;
let _deleteSecureKeyCalls = 0;
let _listMetadataCalls = 0;
let _getMetadataCalls = 0;
let _getMetadataByIdCalls = 0;

// ---------------------------------------------------------------------------
// Mock secure-keys
// ---------------------------------------------------------------------------

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string): string | undefined => {
    _getSecureKeyCalls += 1;
    return secureKeyStore.get(account);
  },
  setSecureKey: (account: string, value: string): boolean => {
    _setSecureKeyCalls += 1;
    secureKeyStore.set(account, value);
    return true;
  },
  setSecureKeyAsync: async (
    account: string,
    value: string,
  ): Promise<boolean> => {
    _setSecureKeyCalls += 1;
    secureKeyStore.set(account, value);
    return true;
  },
  deleteSecureKey: (account: string): "deleted" | "not-found" | "error" => {
    _deleteSecureKeyCalls += 1;
    if (secureKeyStore.has(account)) {
      secureKeyStore.delete(account);
      return "deleted";
    }
    return "not-found";
  },
  deleteSecureKeyAsync: async (
    account: string,
  ): Promise<"deleted" | "not-found" | "error"> => {
    _deleteSecureKeyCalls += 1;
    if (secureKeyStore.has(account)) {
      secureKeyStore.delete(account);
      return "deleted";
    }
    return "not-found";
  },
  listSecureKeys: (): string[] => {
    return [...secureKeyStore.keys()];
  },
  getSecureKeyAsync: async (account: string): Promise<string | undefined> => {
    _getSecureKeyCalls += 1;
    return secureKeyStore.get(account);
  },
  getBackendType: (): "broker" | "encrypted" | null => null,
  isDowngradedFromKeychain: (): boolean => false,
  _resetBackend: (): void => {},
  _setBackend: (): void => {},
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
      accountInfo?: string | null;
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
    _getMetadataCalls += 1;
    return metadataStore.find(
      (c) => c.service === service && c.field === field,
    );
  },
  getCredentialMetadataById: (
    credentialId: string,
  ): CredentialMetadata | undefined => {
    _getMetadataByIdCalls += 1;
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
    _listMetadataCalls += 1;
    return [...metadataStore];
  },
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
  secureKeyStore.set(`credential:${service}:${field}`, secret);
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
    _getSecureKeyCalls = 0;
    _setSecureKeyCalls = 0;
    _deleteSecureKeyCalls = 0;
    _listMetadataCalls = 0;
    _getMetadataCalls = 0;
    _getMetadataByIdCalls = 0;
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
      expect(parsed).toEqual({ ok: true, credentials: [] });
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
        expect(cred).toHaveProperty("accountInfo");
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
      expect(parsed).toEqual({ ok: true, credentials: [] });
    });

    test("list items have the same shape as inspect output", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");

      const listResult = await runCli(["list", "--json"]);
      const listParsed = JSON.parse(listResult.stdout);
      const listItem = listParsed.credentials[0];

      const inspectResult = await runCli([
        "inspect",
        "twilio:account_sid",
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
        "twilio:account_sid",
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
      expect(secureKeyStore.get("credential:twilio:account_sid")).toBe(
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
        "fal:api_key",
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

    test("rejects invalid name without colon", async () => {
      const result = await runCli([
        "set",
        "invalid_name",
        "some_value",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Invalid credential name");
      expect(parsed.error).toContain("service:field");
    });

    test("rejects name with leading colon", async () => {
      const result = await runCli([
        "set",
        ":field_only",
        "some_value",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    test("errors when value argument is missing", async () => {
      const result = await runCli(["set", "twilio:account_sid", "--json"]);
      // Commander should error on missing required arg
      expect(result.exitCode).not.toBe(0);
    });

    test("stores metadata with --allowed-tools", async () => {
      const result = await runCli([
        "set",
        "twilio:auth_token",
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
      await runCli(["set", "twilio:account_sid", "original_value", "--json"]);
      const meta1 = metadataStore.find(
        (m) => m.service === "twilio" && m.field === "account_sid",
      );
      expect(meta1).toBeTruthy();
      const firstUpdatedAt = meta1!.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Second set
      await runCli(["set", "twilio:account_sid", "new_value", "--json"]);
      const meta2 = metadataStore.find(
        (m) => m.service === "twilio" && m.field === "account_sid",
      );
      expect(meta2).toBeTruthy();
      expect(meta2!.updatedAt).toBeGreaterThan(firstUpdatedAt);

      // Verify secret is overwritten
      expect(secureKeyStore.get("credential:twilio:account_sid")).toBe(
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

      const result = await runCli(["delete", "twilio:auth_token", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe("twilio");
      expect(parsed.field).toBe("auth_token");

      // Verify both removed
      expect(secureKeyStore.has("credential:twilio:auth_token")).toBe(false);
      expect(
        metadataStore.find(
          (m) => m.service === "twilio" && m.field === "auth_token",
        ),
      ).toBeUndefined();
    });

    test("errors on nonexistent credential", async () => {
      const result = await runCli(["delete", "twilio:nonexistent", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("rejects invalid name without colon", async () => {
      const result = await runCli(["delete", "badname", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Invalid credential name");
      expect(parsed.error).toContain("service:field");
    });

    test("succeeds when only metadata exists (no secret)", async () => {
      seedMetadataOnly("twilio", "auth_token");

      const result = await runCli(["delete", "twilio:auth_token", "--json"]);
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
  });

  // =========================================================================
  // inspect
  // =========================================================================

  describe("inspect", () => {
    test("shows metadata and scrubbed value by service:field", async () => {
      const meta = seedCredential("twilio", "account_sid", "AC123456789012");

      const result = await runCli(["inspect", "twilio:account_sid", "--json"]);
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
      expect(parsed).toHaveProperty("accountInfo");
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

      const result = await runCli(["inspect", "test:normal", "--json"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.scrubbedValue).toBe("****efgh");
    });

    test("scrubs short secret (<=4 chars): shows only ****", async () => {
      seedCredential("test", "short", "ab");

      const result = await runCli(["inspect", "test:short", "--json"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.scrubbedValue).toBe("****");
    });

    test("shows (not set) when no secret exists", async () => {
      seedMetadataOnly("test", "nosecret");

      const result = await runCli(["inspect", "test:nosecret", "--json"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.scrubbedValue).toBe("(not set)");
      expect(parsed.hasSecret).toBe(false);
    });

    test("rejects invalid name without colon", async () => {
      const result = await runCli(["inspect", "badname", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("rejects name with leading colon", async () => {
      const result = await runCli(["inspect", ":field_only", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Invalid credential name");
      expect(parsed.error).toContain("service:field");
    });

    test("errors on nonexistent credential", async () => {
      const result = await runCli(["inspect", "nonexistent:field", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    test("--json flag produces compact JSON (single line)", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");

      const result = await runCli(["inspect", "twilio:account_sid", "--json"]);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      // Verify it parses as valid JSON
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    test("shows hasSecret: false when metadata exists but no secret", async () => {
      seedMetadataOnly("test", "metaonly");

      const result = await runCli(["inspect", "test:metaonly", "--json"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.hasSecret).toBe(false);
      expect(parsed.scrubbedValue).toBe("(not set)");
    });
  });

  // =========================================================================
  // reveal
  // =========================================================================

  describe("reveal", () => {
    test("returns plaintext value by service:field", async () => {
      seedCredential("twilio", "account_sid", "AC123456789012");

      const result = await runCli(["reveal", "twilio:account_sid", "--json"]);
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

    test("errors on nonexistent credential", async () => {
      const result = await runCli(["reveal", "nonexistent:field", "--json"]);
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

    test("rejects invalid name without colon", async () => {
      const result = await runCli(["reveal", ":field_only", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Invalid credential name");
    });

    test("reveal in human mode emits bare secret with trailing newline", async () => {
      seedCredential("twilio", "auth_token", "secret_xyz_789");

      const result = await runCli(["reveal", "twilio:auth_token"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("secret_xyz_789\n");
    });

    test("errors when metadata exists but no secret stored", async () => {
      seedMetadataOnly("test", "nosecret");

      const result = await runCli(["reveal", "test:nosecret", "--json"]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
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

      // Run `credentials reveal twilio:auth_token`
      const result = await runCli(["reveal", "twilio:auth_token", "--json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toBe("instance_secret_abc123");

      // Verify the correct key was looked up in the secure store
      expect(secureKeyStore.has("credential:twilio:auth_token")).toBe(true);
      expect(secureKeyStore.get("credential:twilio:auth_token")).toBe(
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
      expect(out).toContain("twilio:account_sid");
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
