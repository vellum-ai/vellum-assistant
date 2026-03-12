import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Use encrypted backend with a temp store path
// ---------------------------------------------------------------------------

import { _setStorePath } from "../security/encrypted-store.js";
import { _resetBackend } from "../security/secure-keys.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-credvault-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

// ---------------------------------------------------------------------------
// Mock the registry so importing vault.ts doesn't fail on double-registration
// ---------------------------------------------------------------------------

mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
}));

// ---------------------------------------------------------------------------
// Mock OAuth2 token refresh for token-manager deduplication tests
// ---------------------------------------------------------------------------

let mockRefreshOAuth2Token: ReturnType<
  typeof mock<() => Promise<{ accessToken: string; expiresIn: number }>>
>;

mock.module("../security/oauth2.js", () => {
  mockRefreshOAuth2Token = mock(() =>
    Promise.resolve({
      accessToken: "refreshed-access-token",
      expiresIn: 3600,
    }),
  );
  return {
    refreshOAuth2Token: mockRefreshOAuth2Token,
  };
});

// ---------------------------------------------------------------------------
// Mock oauth-store — token-manager reads refresh config from SQLite
// ---------------------------------------------------------------------------

/** Mutable per-test map of provider connections for getConnectionByProvider */
const mockConnections = new Map<
  string,
  {
    id: string;
    providerKey: string;
    oauthAppId: string;
    expiresAt: number | null;
  }
>();
const mockApps = new Map<
  string,
  {
    id: string;
    providerKey: string;
    clientId: string;
    clientSecretCredentialPath: string;
  }
>();
const mockProviders = new Map<
  string,
  {
    key: string;
    tokenUrl: string;
    tokenEndpointAuthMethod?: string;
  }
>();

let mockDisconnectOAuthProvider: ReturnType<
  typeof mock<
    (providerKey: string) => Promise<"disconnected" | "not-found" | "error">
  >
>;

mock.module("../oauth/oauth-store.js", () => {
  mockDisconnectOAuthProvider = mock((providerKey: string) =>
    Promise.resolve(
      mockConnections.has(providerKey)
        ? ("disconnected" as const)
        : ("not-found" as const),
    ),
  );
  return {
    disconnectOAuthProvider: mockDisconnectOAuthProvider,
    getConnectionByProvider: (service: string) => mockConnections.get(service),
    getApp: (id: string) => mockApps.get(id),
    getProvider: (key: string) => mockProviders.get(key),
    updateConnection: () => {},
    getMostRecentAppByProvider: () => undefined,
    listConnections: () => [],
  };
});

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

// getCredentialValue is no longer exported (sealed in PR 17) — use getSecureKey directly

import { credentialKey } from "../security/credential-key.js";
import {
  deleteSecureKey,
  getSecureKey,
  setSecureKey,
} from "../security/secure-keys.js";
import {
  _resetInflightRefreshes,
  _resetRefreshBreakers,
  withValidToken,
} from "../security/token-manager.js";
import {
  _setMetadataPath,
  getCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { credentialStoreTool } from "../tools/credentials/vault.js";
import type { ToolContext } from "../tools/types.js";

// Create a minimal context for tool execution
const _ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "test-session",
  conversationId: "test-conv",
  trustClass: "guardian",
};

// We'll manually instantiate the tool for testing
// by reimporting the class behavior through the tool's execute method.
// Since the tool registers itself, let's capture it.
let _capturedTool: {
  execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<{ content: string; isError: boolean }>;
};

// Re-mock registry to capture the tool
const { registerTool: _unused, ..._registryRest } =
  await import("../tools/registry.js");

// We need to access the actual tool - let's create it directly
// by re-using the module. Since vault.ts calls registerTool as a side-effect,
// let's just use the secure-keys functions directly + test getCredentialValue.
// For the tool execute tests, we'll create a simple wrapper that mimics the tool.

async function executeVault(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const action = input.action as string;

  switch (action) {
    case "store": {
      const service = input.service as string | undefined;
      const field = input.field as string | undefined;
      const value = input.value as string | undefined;

      if (!service || typeof service !== "string") {
        return {
          content: "Error: service is required for store action",
          isError: true,
        };
      }
      if (!field || typeof field !== "string") {
        return {
          content: "Error: field is required for store action",
          isError: true,
        };
      }
      if (!value || typeof value !== "string") {
        return {
          content: "Error: value is required for store action",
          isError: true,
        };
      }

      const key = credentialKey(service, field);
      const ok = setSecureKey(key, value);
      if (!ok) {
        return { content: "Error: failed to store credential", isError: true };
      }
      return {
        content: `Stored credential for ${service}/${field}.`,
        isError: false,
      };
    }

    case "list":
      return credentialStoreTool.execute({ action: "list" }, _ctx);

    case "delete": {
      const service = input.service as string | undefined;
      const field = input.field as string | undefined;

      if (!service || typeof service !== "string") {
        return {
          content: "Error: service is required for delete action",
          isError: true,
        };
      }
      if (!field || typeof field !== "string") {
        return {
          content: "Error: field is required for delete action",
          isError: true,
        };
      }

      const key = credentialKey(service, field);
      const result = deleteSecureKey(key);
      if (result !== "deleted") {
        return {
          content: `Error: credential ${service}/${field} not found`,
          isError: true,
        };
      }
      return {
        content: `Deleted credential for ${service}/${field}.`,
        isError: false,
      };
    }

    default:
      return { content: `Error: unknown action "${action}"`, isError: true };
  }
}

afterAll(() => {
  mock.restore();
});

describe("credential_store tool", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    _resetBackend();
    // Clear content files but preserve the directory structure
    for (const entry of readdirSync(TEST_DIR)) {
      rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
    }
    _setStorePath(STORE_PATH);
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    mockDisconnectOAuthProvider.mockClear();
    mockConnections.clear();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    mockConnections.clear();
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Store
  // -----------------------------------------------------------------------
  describe("store action", () => {
    test("stores a credential and returns confirmation", async () => {
      const result = await executeVault({
        action: "store",
        service: "gmail",
        field: "password",
        value: "super-secret-123",
      });
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Stored credential for gmail/password.");
    });

    test("stored value NEVER appears in tool output", async () => {
      const testValue = "my-ultra-test-value-xyz";
      const result = await executeVault({
        action: "store",
        service: "github",
        field: "token",
        value: testValue,
      });
      expect(result.content).not.toContain(testValue);
    });

    test("missing service returns error", async () => {
      const result = await executeVault({
        action: "store",
        field: "password",
        value: "val",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("service is required");
    });

    test("missing field returns error", async () => {
      const result = await executeVault({
        action: "store",
        service: "gmail",
        value: "val",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("field is required");
    });

    test("missing value returns error", async () => {
      const result = await executeVault({
        action: "store",
        service: "gmail",
        field: "password",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("value is required");
    });

    test("store success includes credential_id via credentialStoreTool", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "test-cred-id",
          field: "api_key",
          value: "test-value",
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("credential_id:");
      expect(result.content).toContain("test-cred-id/api_key");
      // Verify the credential_id in the output matches the metadata
      const metadata = getCredentialMetadata("test-cred-id", "api_key");
      expect(metadata).toBeDefined();
      expect(result.content).toContain(metadata!.credentialId);
    });
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------
  describe("list action", () => {
    test("lists stored credentials with credential_id, service, field", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "gmail",
          field: "password",
          value: "secret1",
        },
        _ctx,
      );
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "github",
          field: "token",
          value: "secret2",
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.isError).toBe(false);

      const entries = JSON.parse(result.content);
      expect(entries).toHaveLength(2);

      const services = entries
        .map((e: { service: string }) => e.service)
        .sort();
      expect(services).toEqual(["github", "gmail"]);

      // Each entry must have credential_id, service, field
      for (const entry of entries) {
        expect(typeof entry.credential_id).toBe("string");
        expect(entry.credential_id.length).toBeGreaterThan(0);
        expect(typeof entry.service).toBe("string");
        expect(typeof entry.field).toBe("string");
      }

      // Values must NOT appear in the output
      expect(result.content).not.toContain("secret1");
      expect(result.content).not.toContain("secret2");
    });

    test("list output includes alias when set", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "fal-secret",
          alias: "fal-primary",
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      const entries = JSON.parse(result.content);
      const entry = entries.find(
        (e: { service: string }) => e.service === "fal",
      );
      expect(entry).toBeDefined();
      expect(entry.alias).toBe("fal-primary");
    });

    test("list output includes template summary with host patterns", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "fal-secret",
          injection_templates: [
            {
              hostPattern: "*.fal.ai",
              injectionType: "header",
              headerName: "Authorization",
              valuePrefix: "Key ",
            },
            {
              hostPattern: "gateway.fal.ai",
              injectionType: "header",
              headerName: "X-Key",
            },
          ],
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      const entries = JSON.parse(result.content);
      const entry = entries.find(
        (e: { service: string }) => e.service === "fal",
      );
      expect(entry).toBeDefined();
      expect(entry.injection_templates).toBeDefined();
      expect(entry.injection_templates.count).toBe(2);
      expect(entry.injection_templates.host_patterns).toEqual([
        "*.fal.ai",
        "gateway.fal.ai",
      ]);
    });

    test("list does not include credential values", async () => {
      const testValue = "test-dummy-value-for-list";
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "test",
          field: "key",
          value: testValue,
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.content).not.toContain(testValue);
      // Also verify no allowedTools/allowedDomains leak into list output
      const entries = JSON.parse(result.content);
      for (const entry of entries) {
        expect(entry.allowedTools).toBeUndefined();
        expect(entry.allowedDomains).toBeUndefined();
        expect(entry.usageDescription).toBeUndefined();
        expect(entry.value).toBeUndefined();
      }
    });

    test("returns empty array when no credentials exist", async () => {
      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual([]);
    });

    test("lists multiple credentials", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "gmail",
          field: "password",
          value: "s1",
        },
        _ctx,
      );
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "github",
          field: "token",
          value: "s2",
          alias: "gh-main",
        },
        _ctx,
      );
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "s3",
          alias: "fal-primary",
          injection_templates: [
            {
              hostPattern: "*.fal.ai",
              injectionType: "header",
              headerName: "Authorization",
            },
          ],
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      const entries = JSON.parse(result.content);
      expect(entries).toHaveLength(3);

      const fal = entries.find((e: { service: string }) => e.service === "fal");
      expect(fal.alias).toBe("fal-primary");
      expect(fal.injection_templates.count).toBe(1);

      const gh = entries.find(
        (e: { service: string }) => e.service === "github",
      );
      expect(gh.alias).toBe("gh-main");
      expect(gh.injection_templates).toBeUndefined();

      const gmail = entries.find(
        (e: { service: string }) => e.service === "gmail",
      );
      expect(gmail.alias).toBeUndefined();
      expect(gmail.injection_templates).toBeUndefined();
    });

    test("works with metadata store fallback when listing secrets", async () => {
      // Store a credential first (on encrypted backend)
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "keychain-test",
          field: "token",
          value: "kc-secret",
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const entries = JSON.parse(result.content);
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("keychain-test");
      expect(entries[0].field).toBe("token");
      expect(typeof entries[0].credential_id).toBe("string");
    });

    test("returns error when metadata file has unrecognized version", async () => {
      // Write a metadata file with a future version that the current code cannot handle
      const metadataPath = join(TEST_DIR, "metadata.json");
      writeFileSync(
        metadataPath,
        JSON.stringify({ version: 999, credentials: [] }),
        "utf-8",
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("unrecognized version");
    });

    test("excludes metadata entries whose secret was deleted from secure storage", async () => {
      // Store two credentials so both metadata and secrets exist
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "svc-a",
          field: "key",
          value: "val-a",
        },
        _ctx,
      );
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "svc-b",
          field: "key",
          value: "val-b",
        },
        _ctx,
      );

      // Delete the secret directly without going through the tool (simulates
      // a divergence where metadata write failed after secret deletion)
      deleteSecureKey(credentialKey("svc-a", "key"));

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const entries = JSON.parse(result.content);
      // svc-a's secret is gone, so it should be excluded even though metadata exists
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("svc-b");
    });

    test("recovers from corrupt secure storage by resetting and returning empty list", async () => {
      // Store a credential so metadata exists
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "svc-x",
          field: "key",
          value: "val-x",
        },
        _ctx,
      );

      // Corrupt the encrypted store file — the store auto-recovers by
      // backing up the corrupt file and creating a fresh store
      writeFileSync(STORE_PATH, "not-valid-json!!!", "utf-8");

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      // Store auto-recovers: list succeeds but the corrupted credentials are lost
      expect(result.isError).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------
  describe("delete action", () => {
    test("deletes a stored credential", async () => {
      setSecureKey(credentialKey("gmail", "password"), "secret");

      const result = await executeVault({
        action: "delete",
        service: "gmail",
        field: "password",
      });
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Deleted credential for gmail/password.");

      // Verify it's actually gone
      expect(getSecureKey(credentialKey("gmail", "password"))).toBeUndefined();
    });

    test("returns error for non-existent credential", async () => {
      const result = await executeVault({
        action: "delete",
        service: "nonexistent",
        field: "field",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    test("missing service returns error", async () => {
      const result = await executeVault({
        action: "delete",
        field: "password",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("service is required");
    });

    test("missing field returns error", async () => {
      const result = await executeVault({
        action: "delete",
        service: "gmail",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("field is required");
    });

    test("delete also disconnects OAuth connection for the service", async () => {
      // Store a credential via the real tool so metadata exists
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "integration:gmail",
          field: "api_key",
          value: "test-value",
        },
        _ctx,
      );

      // Simulate an active OAuth connection for this service
      mockConnections.set("integration:gmail", {
        id: "conn-gmail",
        providerKey: "integration:gmail",
        oauthAppId: "app-gmail",
        expiresAt: Date.now() + 3600_000,
      });

      const result = await credentialStoreTool.execute(
        {
          action: "delete",
          service: "integration:gmail",
          field: "api_key",
        },
        _ctx,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Deleted credential");
      // Verify disconnectOAuthProvider was called with the service name
      expect(mockDisconnectOAuthProvider).toHaveBeenCalledTimes(1);
      expect(mockDisconnectOAuthProvider).toHaveBeenCalledWith(
        "integration:gmail",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Credential value access (sealed — only via secure-keys internally)
  // -----------------------------------------------------------------------
  describe("credential value access", () => {
    test("credential values are stored via secure keys", () => {
      setSecureKey(credentialKey("github", "token"), "ghp_abc123");
      expect(getSecureKey(credentialKey("github", "token"))).toBe("ghp_abc123");
    });

    test("returns undefined for non-existent credential", () => {
      expect(
        getSecureKey(credentialKey("nonexistent", "field")),
      ).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Hardening verification — getCredentialValue is no longer exported
  // -----------------------------------------------------------------------
  describe("hardening verification", () => {
    test("vault module does not export getCredentialValue", async () => {
      const vaultModule = await import("../tools/credentials/vault.js");
      expect("getCredentialValue" in vaultModule).toBe(false);
    });

    test("store with policy fields persists metadata", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "github",
          field: "token",
          value: "ghp_secret",
          allowed_tools: ["browser_fill_credential"],
          allowed_domains: ["github.com"],
          usage_description: "GitHub login",
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const metadata = getCredentialMetadata("github", "token");
      expect(metadata).toBeDefined();
      expect(metadata!.allowedTools).toEqual(["browser_fill_credential"]);
      expect(metadata!.allowedDomains).toEqual(["github.com"]);
      expect(metadata!.usageDescription).toBe("GitHub login");
    });

    test("store without policy fields defaults to empty arrays", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "slack",
          field: "token",
          value: "xoxb-secret",
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const metadata = getCredentialMetadata("slack", "token");
      expect(metadata).toBeDefined();
      expect(metadata!.allowedTools).toEqual([]);
      expect(metadata!.allowedDomains).toEqual([]);
    });

    test("store rejects invalid policy input", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "test",
          field: "token",
          value: "val",
          allowed_tools: "not-an-array",
        },
        _ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("allowed_tools must be an array");
    });

    test("list action entries do not expose policy metadata", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "myservice",
          field: "myfield",
          value: "secret-val",
          allowed_tools: ["browser_fill_credential"],
          allowed_domains: ["example.com"],
          usage_description: "Test usage",
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      const entries = JSON.parse(result.content);
      const entry = entries.find(
        (e: { service: string; field: string }) =>
          e.service === "myservice" && e.field === "myfield",
      );
      expect(entry).toBeDefined();
      // List entries expose credential_id, service, field (and optionally alias,
      // injection_templates) — never policy details.
      expect(entry.allowedTools).toBeUndefined();
      expect(entry.allowedDomains).toBeUndefined();
      expect(entry.usageDescription).toBeUndefined();
      expect(entry.createdAt).toBeUndefined();
      expect(entry.updatedAt).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Alias and injection template fields
  // -----------------------------------------------------------------------
  describe("alias and injection template fields", () => {
    test("store with valid alias and templates persists metadata", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "fal-key-123",
          alias: "fal-primary",
          injection_templates: [
            {
              hostPattern: "*.fal.ai",
              injectionType: "header",
              headerName: "Authorization",
              valuePrefix: "Key ",
            },
          ],
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const metadata = getCredentialMetadata("fal", "api_key");
      expect(metadata).toBeDefined();
      expect(metadata!.alias).toBe("fal-primary");
      expect(metadata!.injectionTemplates).toHaveLength(1);
      expect(metadata!.injectionTemplates![0].hostPattern).toBe("*.fal.ai");
      expect(metadata!.injectionTemplates![0].injectionType).toBe("header");
      expect(metadata!.injectionTemplates![0].headerName).toBe("Authorization");
      expect(metadata!.injectionTemplates![0].valuePrefix).toBe("Key ");
    });

    test("store with alias only (no templates)", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key",
          value: "sk-test",
          alias: "openai-main",
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const metadata = getCredentialMetadata("openai", "api_key");
      expect(metadata).toBeDefined();
      expect(metadata!.alias).toBe("openai-main");
      expect(metadata!.injectionTemplates).toBeUndefined();
    });

    test("store with templates only (no alias)", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "replicate",
          field: "token",
          value: "r8_test",
          injection_templates: [
            {
              hostPattern: "api.replicate.com",
              injectionType: "header",
              headerName: "Authorization",
              valuePrefix: "Bearer ",
            },
          ],
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const metadata = getCredentialMetadata("replicate", "token");
      expect(metadata).toBeDefined();
      expect(metadata!.alias).toBeUndefined();
      expect(metadata!.injectionTemplates).toHaveLength(1);
      expect(metadata!.injectionTemplates![0].injectionType).toBe("header");
    });

    test("rejects template missing headerName for header type", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "fal-key-123",
          injection_templates: [
            {
              hostPattern: "*.fal.ai",
              injectionType: "header",
              // missing headerName
            },
          ],
        },
        _ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("headerName is required");
    });

    test("rejects template missing queryParamName for query type", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "mapbox",
          field: "token",
          value: "pk.test",
          injection_templates: [
            {
              hostPattern: "api.mapbox.com",
              injectionType: "query",
              // missing queryParamName
            },
          ],
        },
        _ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("queryParamName is required");
    });

    test("round-trip: store then list shows the credential", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "anthropic",
          field: "api_key",
          value: "sk-ant-test",
          alias: "claude-key",
          injection_templates: [
            {
              hostPattern: "api.anthropic.com",
              injectionType: "header",
              headerName: "x-api-key",
            },
          ],
        },
        _ctx,
      );

      const listResult = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(listResult.isError).toBe(false);
      const entries = JSON.parse(listResult.content);
      const entry = entries.find(
        (e: { service: string; field: string }) =>
          e.service === "anthropic" && e.field === "api_key",
      );
      expect(entry).toBeDefined();

      // Verify metadata persisted correctly
      const metadata = getCredentialMetadata("anthropic", "api_key");
      expect(metadata).toBeDefined();
      expect(metadata!.alias).toBe("claude-key");
      expect(metadata!.injectionTemplates).toHaveLength(1);
    });

    test("update alias on existing credential", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "fal-key-123",
          alias: "fal-old",
        },
        _ctx,
      );

      let metadata = getCredentialMetadata("fal", "api_key");
      expect(metadata!.alias).toBe("fal-old");

      // Re-store same credential with updated alias
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "fal",
          field: "api_key",
          value: "fal-key-123",
          alias: "fal-new",
        },
        _ctx,
      );

      metadata = getCredentialMetadata("fal", "api_key");
      expect(metadata!.alias).toBe("fal-new");
    });

    test("store with query injection template", async () => {
      const result = await credentialStoreTool.execute(
        {
          action: "store",
          service: "mapbox",
          field: "token",
          value: "pk.test123",
          injection_templates: [
            {
              hostPattern: "api.mapbox.com",
              injectionType: "query",
              queryParamName: "access_token",
            },
          ],
        },
        _ctx,
      );
      expect(result.isError).toBe(false);
      const metadata = getCredentialMetadata("mapbox", "token");
      expect(metadata!.injectionTemplates).toHaveLength(1);
      expect(metadata!.injectionTemplates![0].injectionType).toBe("query");
      expect(metadata!.injectionTemplates![0].queryParamName).toBe(
        "access_token",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Multi-key same-service vault storage
  // -----------------------------------------------------------------------
  describe("multi-key same-service storage", () => {
    test("stores two credentials with same service but different aliases", async () => {
      const result1 = await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key_prod",
          value: "sk-prod-abc",
          alias: "production",
        },
        _ctx,
      );
      expect(result1.isError).toBe(false);

      const result2 = await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key_staging",
          value: "sk-staging-xyz",
          alias: "staging",
        },
        _ctx,
      );
      expect(result2.isError).toBe(false);

      // Verify both stored independently in metadata
      const meta1 = getCredentialMetadata("openai", "api_key_prod");
      const meta2 = getCredentialMetadata("openai", "api_key_staging");
      expect(meta1).toBeDefined();
      expect(meta2).toBeDefined();
      expect(meta1!.alias).toBe("production");
      expect(meta2!.alias).toBe("staging");
    });

    test("listing shows both same-service credentials independently", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key_prod",
          value: "sk-prod-abc",
          alias: "production",
        },
        _ctx,
      );
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key_staging",
          value: "sk-staging-xyz",
          alias: "staging",
        },
        _ctx,
      );

      const result = await credentialStoreTool.execute(
        { action: "list" },
        _ctx,
      );
      expect(result.isError).toBe(false);

      const entries = JSON.parse(result.content);
      const openaiEntries = entries.filter(
        (e: { service: string }) => e.service === "openai",
      );
      expect(openaiEntries).toHaveLength(2);

      const aliases = openaiEntries
        .map((e: { alias?: string }) => e.alias)
        .sort();
      expect(aliases).toEqual(["production", "staging"]);
    });

    test("each same-service credential has its own credential_id", async () => {
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key_prod",
          value: "sk-prod-abc",
          alias: "production",
        },
        _ctx,
      );
      await credentialStoreTool.execute(
        {
          action: "store",
          service: "openai",
          field: "api_key_staging",
          value: "sk-staging-xyz",
          alias: "staging",
        },
        _ctx,
      );

      const meta1 = getCredentialMetadata("openai", "api_key_prod");
      const meta2 = getCredentialMetadata("openai", "api_key_staging");
      expect(meta1).toBeDefined();
      expect(meta2).toBeDefined();
      expect(meta1!.credentialId).not.toBe(meta2!.credentialId);
      // Both should be valid UUIDs (non-empty strings)
      expect(meta1!.credentialId.length).toBeGreaterThan(0);
      expect(meta2!.credentialId.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Namespace isolation
  // -----------------------------------------------------------------------
  describe("namespace isolation", () => {
    test("different services with same field do not collide", async () => {
      await executeVault({
        action: "store",
        service: "gmail",
        field: "password",
        value: "gmail-pass",
      });
      await executeVault({
        action: "store",
        service: "github",
        field: "password",
        value: "github-pass",
      });

      expect(getSecureKey(credentialKey("gmail", "password"))).toBe(
        "gmail-pass",
      );
      expect(getSecureKey(credentialKey("github", "password"))).toBe(
        "github-pass",
      );
    });

    test("same service with different fields do not collide", async () => {
      await executeVault({
        action: "store",
        service: "gmail",
        field: "password",
        value: "pass123",
      });
      await executeVault({
        action: "store",
        service: "gmail",
        field: "recovery_email",
        value: "backup@example.com",
      });

      expect(getSecureKey(credentialKey("gmail", "password"))).toBe("pass123");
      expect(getSecureKey(credentialKey("gmail", "recovery_email"))).toBe(
        "backup@example.com",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Token refresh deduplication tests
// ---------------------------------------------------------------------------

describe("withValidToken refresh deduplication", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    _resetBackend();
    for (const entry of readdirSync(TEST_DIR)) {
      rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
    }
    _setStorePath(STORE_PATH);
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    _resetRefreshBreakers();
    _resetInflightRefreshes();
    mockRefreshOAuth2Token.mockClear();
    // Clear mock oauth-store maps
    mockConnections.clear();
    mockApps.clear();
    mockProviders.clear();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    _resetRefreshBreakers();
    _resetInflightRefreshes();
    mockConnections.clear();
    mockApps.clear();
    mockProviders.clear();
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /**
   * Helper: set up a service with an access token, refresh token, and
   * mock DB data so that token refresh can proceed through doRefresh().
   *
   * OAuth-specific fields (tokenUrl, clientId, expiresAt) are now stored
   * in the SQLite oauth-store. The mock maps simulate the DB layer.
   */
  function setupService(
    service: string,
    opts?: { expired?: boolean; accessToken?: string },
  ) {
    const accessToken = opts?.accessToken ?? "old-access-token";

    // Seed mock oauth-store maps so token-manager can resolve refresh config
    const appId = `app-${service}`;
    const connId = `conn-${service}`;

    // Store access token under the oauth_connection key path that
    // withValidToken reads (not the legacy credentialKey path).
    setSecureKey(`oauth_connection/${connId}/access_token`, accessToken);
    mockProviders.set(service, {
      key: service,
      tokenUrl: "https://oauth.example.com/token",
    });
    mockApps.set(appId, {
      id: appId,
      providerKey: service,
      clientId: "test-client-id",
      clientSecretCredentialPath: `oauth_app/${appId}/client_secret`,
    });
    mockConnections.set(service, {
      id: connId,
      providerKey: service,
      oauthAppId: appId,
      expiresAt: opts?.expired
        ? Date.now() - 60_000 // expired 1 minute ago
        : Date.now() + 3600_000, // expires in 1 hour
    });
    // Store refresh token and client_secret in secure keys (token-manager reads them)
    setSecureKey(
      `oauth_connection/${connId}/refresh_token`,
      "valid-refresh-token",
    );
    setSecureKey(`oauth_app/${appId}/client_secret`, "test-client-secret");
  }

  test("3 concurrent 401 refreshes for the same service call doRefresh exactly once", async () => {
    setupService("integration:gmail");

    let resolveRefresh!: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void;
    const refreshPromise = new Promise<{
      accessToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveRefresh = resolve;
    });

    mockRefreshOAuth2Token.mockImplementation(() => refreshPromise);

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    const callback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return `result-with-${token}`;
    };

    // Launch 3 concurrent withValidToken calls — all will get a non-expired
    // token first, call the callback, get a 401, and then try to refresh.
    const p1 = withValidToken("integration:gmail", callback);
    const p2 = withValidToken("integration:gmail", callback);
    const p3 = withValidToken("integration:gmail", callback);

    // Let the event loop tick so all 3 calls enter the 401 retry path
    await new Promise((r) => setTimeout(r, 10));

    // Resolve the single refresh attempt
    resolveRefresh({ accessToken: "new-token-123", expiresIn: 3600 });

    const results = await Promise.all([p1, p2, p3]);

    // All 3 should succeed with the refreshed token
    expect(results).toEqual([
      "result-with-new-token-123",
      "result-with-new-token-123",
      "result-with-new-token-123",
    ]);

    // refreshOAuth2Token should have been called exactly once
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });

  test("concurrent refreshes for different services proceed independently", async () => {
    setupService("integration:gmail");
    setupService("integration:slack");

    let resolveGmail!: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void;
    let resolveSlack!: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void;

    const gmailPromise = new Promise<{
      accessToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveGmail = resolve;
    });
    const slackPromise = new Promise<{
      accessToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveSlack = resolve;
    });

    let refreshCallCount = 0;
    mockRefreshOAuth2Token.mockImplementation(() => {
      refreshCallCount++;
      // Both services use the same tokenUrl in this test, so we track by
      // call order to return the correct deferred promise.
      if (refreshCallCount === 1) return gmailPromise;
      return slackPromise;
    });

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    const gmailCallback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return `gmail-${token}`;
    };
    const slackCallback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return `slack-${token}`;
    };

    const p1 = withValidToken("integration:gmail", gmailCallback);
    const p2 = withValidToken("integration:slack", slackCallback);

    await new Promise((r) => setTimeout(r, 10));

    // Resolve both independently
    resolveGmail({ accessToken: "gmail-new-token", expiresIn: 3600 });
    resolveSlack({ accessToken: "slack-new-token", expiresIn: 3600 });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("gmail-gmail-new-token");
    expect(r2).toBe("slack-slack-new-token");

    // Both services should have triggered their own refresh
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(2);
  });

  test("deduplication cleans up after refresh completes, allowing subsequent refreshes", async () => {
    setupService("integration:gmail");

    let refreshCount = 0;
    mockRefreshOAuth2Token.mockImplementation(() => {
      refreshCount++;
      return Promise.resolve({
        accessToken: `token-${refreshCount}`,
        expiresIn: 3600,
      });
    });

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    // First call triggers a refresh (old token → 401 → refresh → token-1)
    const r1 = await withValidToken(
      "integration:gmail",
      async (token: string) => {
        if (token !== "token-1") throw err401;
        return token;
      },
    );
    expect(r1).toBe("token-1");
    expect(refreshCount).toBe(1);

    // Second call also triggers a 401 to verify dedup state was cleaned up
    // and a new refresh is allowed (not deduplicated with the first).
    const r2 = await withValidToken(
      "integration:gmail",
      async (token: string) => {
        if (token !== "token-2") throw err401;
        return token;
      },
    );
    expect(r2).toBe("token-2");
    // Second refresh should have happened (not deduplicated with the first,
    // since the first already completed)
    expect(refreshCount).toBe(2);
  });

  test("deduplication propagates refresh errors to all waiting callers", async () => {
    setupService("integration:gmail");

    mockRefreshOAuth2Token.mockImplementation(() =>
      Promise.reject(
        Object.assign(
          new Error("OAuth2 token refresh failed (HTTP 401: invalid_grant)"),
        ),
      ),
    );

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    const callback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return "should-not-reach";
    };

    // Launch 2 concurrent calls — both should fail with the same error
    const p1 = withValidToken("integration:gmail", callback);
    const p2 = withValidToken("integration:gmail", callback);

    const results = await Promise.allSettled([p1, p2]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");

    // Only one actual refresh attempt
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });
});
