import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
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
  `vellum-broker-server-use-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

// ---------------------------------------------------------------------------
// Mock registry to avoid double-registration
// ---------------------------------------------------------------------------

mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { credentialKey } from "../security/credential-key.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { CredentialBroker } from "../tools/credentials/broker.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

// ---------------------------------------------------------------------------
// Tests — serverUse (publish_page / unpublish_page regression)
// ---------------------------------------------------------------------------

afterAll(() => {
  mock.restore();
});

describe("CredentialBroker.serverUse", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("executes callback with credential value and returns result", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async (token) => {
        // Verify the callback receives the actual secret
        expect(token).toBe("test-vercel-token");
        return { deploymentId: "dpl_123", url: "https://example.vercel.app" };
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      deploymentId: "dpl_123",
      url: "https://example.vercel.app",
    });
  });

  test("denies when tool is not in allowedTools", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "unpublish_page",
      execute: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  test("denies when no credential metadata exists", async () => {
    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("No credential found");
  });

  test("denies when credential has no stored value", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
    });
    // No setSecureKeyAsync — metadata exists but value doesn't

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no stored value");
  });

  test("returns generic error when callback throws (no secret leakage)", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("Vercel API 401: invalid token test-vercel-token");
      },
    });

    expect(result.success).toBe(false);
    // The error message must NOT contain the secret
    expect(result.reason).not.toContain("test-vercel-token");
    expect(result.reason).toBe("Credential use failed");
  });

  test("secret value never appears in the result object", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => ({ status: "deployed" }),
    });

    // Serialize the entire result and verify no secret leakage
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("test-vercel-token");
  });

  test("denies when credential has domain restrictions", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
      allowedDomains: ["vercel.com"],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("domain restrictions");
    expect(result.reason).toContain("vercel.com");
  });

  test("allows when credential has no domain restrictions", async () => {
    upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["publish_page"],
      allowedDomains: [],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async (token) => {
        expect(token).toBe("test-vercel-token");
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Baseline: tool/domain policy mismatch deny behavior
  // ---------------------------------------------------------------------------

  describe("baseline — tool policy mismatch deny", () => {
    test("denies tool not in multi-tool allowlist and lists allowed tools", async () => {
      upsertCredentialMetadata("aws", "access_key", {
        allowedTools: ["deploy_lambda", "s3_upload"],
      });
      await setSecureKeyAsync(credentialKey("aws", "access_key"), "AKIA_test");

      const result = await broker.serverUse({
        service: "aws",
        field: "access_key",
        toolName: "ec2_terminate",
        execute: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("ec2_terminate");
      expect(result.reason).toContain("not allowed");
      // The denial message should enumerate the allowed tools
      expect(result.reason).toContain("deploy_lambda");
      expect(result.reason).toContain("s3_upload");
    });

    test("denies with empty allowedTools and suggests updating credential", async () => {
      upsertCredentialMetadata("stripe", "secret_key", {
        allowedTools: [],
      });
      await setSecureKeyAsync(
        credentialKey("stripe", "secret_key"),
        "sk_test_xyz",
      );

      const result = await broker.serverUse({
        service: "stripe",
        field: "secret_key",
        toolName: "charge_card",
        execute: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("No tools are currently allowed");
      expect(result.reason).toContain("credential_store");
    });

    test("denies when credential has domain restrictions even if tool matches", async () => {
      upsertCredentialMetadata("github", "oauth_token", {
        allowedTools: ["git_push"],
        allowedDomains: ["github.com"],
      });
      await setSecureKeyAsync(
        credentialKey("github", "oauth_token"),
        "gho_test",
      );

      const result = await broker.serverUse({
        service: "github",
        field: "oauth_token",
        toolName: "git_push",
        execute: async () => {
          throw new Error("should not be called");
        },
      });

      // Domain-restricted credentials are blocked for all server-side use
      expect(result.success).toBe(false);
      expect(result.reason).toContain("domain restrictions");
      expect(result.reason).toContain("cannot be used server-side");
    });
  });

  // ---------------------------------------------------------------------------
  // Baseline: service/field uniqueness assumptions
  // ---------------------------------------------------------------------------

  describe("baseline — service/field uniqueness", () => {
    test("upsert overwrites metadata for same service+field pair", async () => {
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["publish_page"],
      });
      // Second upsert with the same service+field updates the record
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["publish_page", "unpublish_page"],
      });
      await setSecureKeyAsync(
        credentialKey("vercel", "api_token"),
        "tok_updated",
      );

      const result = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "unpublish_page",
        execute: async (v) => v.length,
      });

      // The second upsert's allowedTools should be in effect
      expect(result.success).toBe(true);
    });

    test("same service with different fields are independent credentials", async () => {
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["publish_page"],
      });
      upsertCredentialMetadata("vercel", "deploy_hook", {
        allowedTools: ["trigger_deploy"],
      });
      await setSecureKeyAsync(credentialKey("vercel", "api_token"), "tok_api");
      await setSecureKeyAsync(
        credentialKey("vercel", "deploy_hook"),
        "hook_secret",
      );

      // api_token should deny trigger_deploy
      const r1 = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "trigger_deploy",
        execute: async () => {
          throw new Error("should not be called");
        },
      });
      expect(r1.success).toBe(false);

      // deploy_hook should allow trigger_deploy
      const r2 = await broker.serverUse({
        service: "vercel",
        field: "deploy_hook",
        toolName: "trigger_deploy",
        execute: async (v) => {
          expect(v).toBe("hook_secret");
          return "triggered";
        },
      });
      expect(r2.success).toBe(true);
      expect(r2.result).toBe("triggered");
    });

    test("different services with same field name are independent (serverUseById)", async () => {
      const meta1 = upsertCredentialMetadata("github", "api_token", {
        allowedTools: ["github_api"],
      });
      upsertCredentialMetadata("gitlab", "api_token", {
        allowedTools: ["gitlab_api"],
      });
      await setSecureKeyAsync(credentialKey("github", "api_token"), "gh_tok");
      await setSecureKeyAsync(credentialKey("gitlab", "api_token"), "gl_tok");

      // github credential should not serve gitlab tool
      const r1 = await broker.serverUseById({
        credentialId: meta1.credentialId,
        requestingTool: "gitlab_api",
      });
      expect(r1.success).toBe(false);
    });

    test("different services with same field name are independent", async () => {
      upsertCredentialMetadata("github", "api_token", {
        allowedTools: ["github_api"],
      });
      upsertCredentialMetadata("gitlab", "api_token", {
        allowedTools: ["gitlab_api"],
      });
      await setSecureKeyAsync(credentialKey("github", "api_token"), "gh_tok");
      await setSecureKeyAsync(credentialKey("gitlab", "api_token"), "gl_tok");

      // github credential should not serve gitlab tool
      const r1 = await broker.serverUse({
        service: "github",
        field: "api_token",
        toolName: "gitlab_api",
        execute: async () => {
          throw new Error("should not be called");
        },
      });
      expect(r1.success).toBe(false);

      // gitlab credential serves its own tool with its own value
      const r2 = await broker.serverUse({
        service: "gitlab",
        field: "api_token",
        toolName: "gitlab_api",
        execute: async (v) => {
          expect(v).toBe("gl_tok");
          return "ok";
        },
      });
      expect(r2.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — serverUseById (proxy credential consumption by ID)
// ---------------------------------------------------------------------------

describe("CredentialBroker.serverUseById", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("returns metadata and injection templates for valid credential", async () => {
    const meta = upsertCredentialMetadata("fal", "api_key", {
      allowedTools: ["media_proxy"],
      injectionTemplates: [
        {
          hostPattern: "*.fal.ai",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Key ",
        },
      ],
    });
    await setSecureKeyAsync(credentialKey("fal", "api_key"), "fal-secret-key");

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "media_proxy",
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.credentialId).toBe(meta.credentialId);
    expect(result.service).toBe("fal");
    expect(result.field).toBe("api_key");
    expect(result.injectionTemplates).toHaveLength(1);
    expect(result.injectionTemplates[0].hostPattern).toBe("*.fal.ai");
    expect(result.injectionTemplates[0].headerName).toBe("Authorization");
    expect(result.injectionTemplates[0].valuePrefix).toBe("Key ");
    // Secret value must NEVER appear in the result
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("fal-secret-key");
  });

  test("denies when requesting tool is not in allowed list", async () => {
    const meta = upsertCredentialMetadata("fal", "api_key", {
      allowedTools: ["media_proxy"],
    });
    await setSecureKeyAsync(credentialKey("fal", "api_key"), "fal-secret-key");

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "unauthorized_tool",
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected denial");
    expect(result.reason).toContain("not allowed");
    expect(result.reason).toContain("unauthorized_tool");
    expect(result.reason).toContain("media_proxy");
  });

  test("returns not found for unknown credential ID", async () => {
    const result = await broker.serverUseById({
      credentialId: "nonexistent-id",
      requestingTool: "media_proxy",
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected denial");
    expect(result.reason).toContain("No credential found");
    expect(result.reason).toContain("nonexistent-id");
  });

  test("denies when credential has domain restrictions", async () => {
    const meta = upsertCredentialMetadata("github", "oauth_token", {
      allowedTools: ["media_proxy"],
      allowedDomains: ["github.com"],
    });
    await setSecureKeyAsync(credentialKey("github", "oauth_token"), "gho_test");

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "media_proxy",
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected denial");
    expect(result.reason).toContain("domain restrictions");
    expect(result.reason).toContain("cannot be used server-side");
  });

  test("returns empty injection templates when credential has none", async () => {
    const meta = upsertCredentialMetadata("vercel", "api_token", {
      allowedTools: ["media_proxy"],
    });
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "media_proxy",
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.injectionTemplates).toEqual([]);
  });

  test("denies with empty allowedTools and suggests updating credential", async () => {
    const meta = upsertCredentialMetadata("stripe", "secret_key", {
      allowedTools: [],
    });
    await setSecureKeyAsync(
      credentialKey("stripe", "secret_key"),
      "sk_test_xyz",
    );

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "media_proxy",
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected denial");
    expect(result.reason).toContain("No tools are currently allowed");
    expect(result.reason).toContain("credential_store");
  });

  test("denies when metadata exists but no stored secret value", async () => {
    const meta = upsertCredentialMetadata("fal", "api_key", {
      allowedTools: ["media_proxy"],
      injectionTemplates: [
        {
          hostPattern: "*.fal.ai",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Key ",
        },
      ],
    });
    // No setSecureKeyAsync — metadata exists but value doesn't

    const result = await broker.serverUseById({
      credentialId: meta.credentialId,
      requestingTool: "media_proxy",
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected denial");
    expect(result.reason).toContain("no stored value");
  });
});
