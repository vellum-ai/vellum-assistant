import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
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
  `vellum-broker-fill-test-${randomBytes(4).toString("hex")}`,
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
import { BROWSER_FILL_CAPABILITY } from "../tools/credentials/tool-policy.js";

afterAll(() => {
  mock.restore();
});

describe("CredentialBroker.browserFill", () => {
  let broker: CredentialBroker;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    // Clear content files but preserve the directory structure
    for (const entry of readdirSync(TEST_DIR)) {
      rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
    }
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("fills successfully when credential exists", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    let filledValue: string | undefined;
    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async (value) => {
        filledValue = value;
      },
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    // The fill callback received the plaintext
    expect(filledValue).toBe("ghp_secret123");
  });

  test("returns metadata-only result (no plaintext in return value)", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {},
    });

    // Result has no plaintext value — only success/failure metadata
    expect(result).toEqual({ success: true });
    expect("value" in result).toBe(false);
    expect("storageKey" in result).toBe(false);
  });

  test("fails when no credential metadata exists", async () => {
    const result = await broker.browserFill({
      service: "nonexistent",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("No credential found");
    expect(result.reason).toContain("nonexistent/token");
  });

  test("fails when metadata exists but no stored secret value", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    // No setSecureKeyAsync call — metadata exists but value doesn't

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no stored value");
  });

  test("returns failure when fill callback throws", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("Element not found");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Fill operation failed");
    // The broker intentionally returns a generic error — the original error
    // message is NOT included because it could embed the credential value,
    // leaking plaintext outside the broker's trust boundary.
    expect(result.reason).not.toContain("Element not found");
  });

  test("handles multiple fills with different credentials", async () => {
    upsertCredentialMetadata("github", "username", {
      allowedTools: ["browser_fill_credential"],
    });
    upsertCredentialMetadata("github", "password", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("github", "username"), "octocat");
    await setSecureKeyAsync(credentialKey("github", "password"), "hunter2");

    const filled: Record<string, string> = {};

    const r1 = await broker.browserFill({
      service: "github",
      field: "username",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled.username = v;
      },
    });

    const r2 = await broker.browserFill({
      service: "github",
      field: "password",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled.password = v;
      },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(filled.username).toBe("octocat");
    expect(filled.password).toBe("hunter2");
  });

  test("allows fill when domain matches allowedDomains", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
      allowedDomains: ["github.com"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      domain: "github.com",
      fill: async () => {},
    });

    expect(result.success).toBe(true);
  });

  test("allows fill on subdomain when registrable domain matches", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
      allowedDomains: ["github.com"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      domain: "login.github.com",
      fill: async () => {},
    });

    expect(result.success).toBe(true);
  });

  test("denies fill when domain does not match allowedDomains", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
      allowedDomains: ["github.com"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      domain: "evil.com",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("not allowed");
    expect(result.reason).toContain("evil.com");
    expect(result.reason).toContain("github.com");
  });

  test("denies fill when domain policy exists but no domain provided", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
      allowedDomains: ["github.com"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no page domain was provided");
  });

  test("skips domain check when allowedDomains is empty", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    // No domain provided and no allowedDomains policy — should succeed
    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {},
    });

    expect(result.success).toBe(true);
  });

  test("denies fill when tool is not in allowedTools", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["other_tool"],
    });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    let fillCalled = false;
    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        fillCalled = true;
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("not allowed");
    expect(result.reason).toContain("browser_fill_credential");
    // Fill callback must not be invoked when policy denies
    expect(fillCalled).toBe(false);
  });

  test("denies fill when allowedTools is empty (fail-closed)", async () => {
    upsertCredentialMetadata("github", "token", { allowedTools: [] });
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("No tools are currently allowed");
  });

  test("fill callback error does not leak plaintext in result", async () => {
    upsertCredentialMetadata("github", "token", {
      allowedTools: ["browser_fill_credential"],
    });
    await setSecureKeyAsync(
      credentialKey("github", "token"),
      "ghp_supersecret",
    );

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("timeout");
      },
    });

    expect(result.success).toBe(false);
    // Ensure the secret value doesn't appear in the error result
    expect(JSON.stringify(result)).not.toContain("ghp_supersecret");
  });

  // ---------------------------------------------------------------------------
  // Baseline: tool/domain policy mismatch deny behavior
  // ---------------------------------------------------------------------------

  describe("baseline — tool/domain policy mismatch deny", () => {
    test("denies tool not in multi-tool allowlist and enumerates allowed tools", async () => {
      upsertCredentialMetadata("aws", "access_key", {
        allowedTools: ["s3_upload", "cloudfront_invalidate"],
        allowedDomains: [],
      });
      await setSecureKeyAsync(credentialKey("aws", "access_key"), "AKIA_test");

      let fillCalled = false;
      const result = await broker.browserFill({
        service: "aws",
        field: "access_key",
        toolName: "browser_fill_credential",
        fill: async () => {
          fillCalled = true;
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("browser_fill_credential");
      expect(result.reason).toContain("not allowed");
      expect(result.reason).toContain("s3_upload");
      expect(result.reason).toContain("cloudfront_invalidate");
      expect(fillCalled).toBe(false);
    });

    test("denies when tool matches but domain does not", async () => {
      upsertCredentialMetadata("github", "pat", {
        allowedTools: ["browser_fill_credential"],
        allowedDomains: ["github.com"],
      });
      await setSecureKeyAsync(credentialKey("github", "pat"), "ghp_fill_test");

      let fillCalled = false;
      const result = await broker.browserFill({
        service: "github",
        field: "pat",
        toolName: "browser_fill_credential",
        domain: "phishing-github.com",
        fill: async () => {
          fillCalled = true;
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("phishing-github.com");
      expect(result.reason).toContain("not allowed");
      expect(fillCalled).toBe(false);
    });

    test("denies when both tool and domain mismatch — tool check runs first", async () => {
      upsertCredentialMetadata("slack", "bot_token", {
        allowedTools: ["slack_post"],
        allowedDomains: ["slack.com"],
      });
      await setSecureKeyAsync(credentialKey("slack", "bot_token"), "xoxb-test");

      const result = await broker.browserFill({
        service: "slack",
        field: "bot_token",
        toolName: "browser_fill_credential",
        domain: "evil.com",
        fill: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
      // Tool policy is evaluated before domain policy, so the denial
      // mentions the tool name, not the domain
      expect(result.reason).toContain("browser_fill_credential");
      expect(result.reason).toContain("not allowed");
    });

    test("denies with empty allowedTools and suggests credential_store", async () => {
      upsertCredentialMetadata("custom", "key", {
        allowedTools: [],
      });
      await setSecureKeyAsync(credentialKey("custom", "key"), "secret");

      const result = await broker.browserFill({
        service: "custom",
        field: "key",
        toolName: "browser_fill_credential",
        fill: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("No tools are currently allowed");
      expect(result.reason).toContain("credential_store");
    });
  });

  // ---------------------------------------------------------------------------
  // Baseline: service/field uniqueness assumptions
  // ---------------------------------------------------------------------------

  describe("baseline — service/field uniqueness", () => {
    test("upsert overwrites metadata for same service+field pair", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["other_tool"],
      });
      // Second upsert updates the same record
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "ghp_updated");

      let filledValue: string | undefined;
      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filledValue = v;
        },
      });

      // The second upsert's policy should be in effect
      expect(result.success).toBe(true);
      expect(filledValue).toBe("ghp_updated");
    });

    test("same service with different fields are independent credentials", async () => {
      upsertCredentialMetadata("github", "username", {
        allowedTools: ["browser_fill_credential"],
      });
      upsertCredentialMetadata("github", "password", {
        allowedTools: ["other_tool"],
      });
      await setSecureKeyAsync(credentialKey("github", "username"), "octocat");
      await setSecureKeyAsync(credentialKey("github", "password"), "hunter2");

      // username allows browser_fill_credential
      const r1 = await broker.browserFill({
        service: "github",
        field: "username",
        toolName: "browser_fill_credential",
        fill: async () => {},
      });
      expect(r1.success).toBe(true);

      // password does NOT allow browser_fill_credential
      const r2 = await broker.browserFill({
        service: "github",
        field: "password",
        toolName: "browser_fill_credential",
        fill: async () => {
          throw new Error("should not be called");
        },
      });
      expect(r2.success).toBe(false);
      expect(r2.reason).toContain("not allowed");
    });

    test("different services with same field name are independent", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
        allowedDomains: ["github.com"],
      });
      upsertCredentialMetadata("gitlab", "token", {
        allowedTools: ["browser_fill_credential"],
        allowedDomains: ["gitlab.com"],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "gh_tok");
      await setSecureKeyAsync(credentialKey("gitlab", "token"), "gl_tok");

      // github credential on github.com succeeds
      let filled1 = "";
      const r1 = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        domain: "github.com",
        fill: async (v) => {
          filled1 = v;
        },
      });
      expect(r1.success).toBe(true);
      expect(filled1).toBe("gh_tok");

      // github credential on gitlab.com fails (domain mismatch)
      const r2 = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        domain: "gitlab.com",
        fill: async () => {
          throw new Error("should not be called");
        },
      });
      expect(r2.success).toBe(false);

      // gitlab credential on gitlab.com succeeds with its own value
      let filled3 = "";
      const r3 = await broker.browserFill({
        service: "gitlab",
        field: "token",
        toolName: "browser_fill_credential",
        domain: "gitlab.com",
        fill: async (v) => {
          filled3 = v;
        },
      });
      expect(r3.success).toBe(true);
      expect(filled3).toBe("gl_tok");
    });
  });

  // ---------------------------------------------------------------------------
  // Canonical capability key and legacy alias regression
  // ---------------------------------------------------------------------------

  describe("canonical capability key and legacy alias", () => {
    test("credential restricted to canonical key authorizes browser fill", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });
      await setSecureKeyAsync(
        credentialKey("github", "token"),
        "ghp_canonical",
      );

      let filledValue: string | undefined;
      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
        fill: async (v) => {
          filledValue = v;
        },
      });

      expect(result.success).toBe(true);
      expect(filledValue).toBe("ghp_canonical");
    });

    test("legacy browser_fill_credential metadata authorizes canonical capability key", async () => {
      // Stored with legacy tool name — simulates existing metadata on disk
      upsertCredentialMetadata("github", "pat", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(credentialKey("github", "pat"), "ghp_legacy");

      let filledValue: string | undefined;
      const result = await broker.browserFill({
        service: "github",
        field: "pat",
        toolName: BROWSER_FILL_CAPABILITY,
        fill: async (v) => {
          filledValue = v;
        },
      });

      expect(result.success).toBe(true);
      expect(filledValue).toBe("ghp_legacy");
    });

    test("canonical key in metadata authorizes legacy browser_fill_credential requests", async () => {
      upsertCredentialMetadata("gitlab", "token", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });
      await setSecureKeyAsync(credentialKey("gitlab", "token"), "gl_mixed");

      let filledValue: string | undefined;
      const result = await broker.browserFill({
        service: "gitlab",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filledValue = v;
        },
      });

      expect(result.success).toBe(true);
      expect(filledValue).toBe("gl_mixed");
    });

    test("empty allowedTools still fails closed with canonical key", async () => {
      upsertCredentialMetadata("github", "token", { allowedTools: [] });
      await setSecureKeyAsync(credentialKey("github", "token"), "ghp_no_tools");

      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
        fill: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("No tools are currently allowed");
    });

    test("incorrect allowlist denies canonical key (fail closed)", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["some_other_tool"],
      });
      await setSecureKeyAsync(
        credentialKey("github", "token"),
        "ghp_wrong_tool",
      );

      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
        fill: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("not allowed");
    });
  });
});
