import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { _resetBackend, setSecureKeyAsync } from "../security/secure-keys.js";
import { CredentialBroker } from "../tools/credentials/broker.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { BROWSER_FILL_CAPABILITY } from "../tools/credentials/tool-policy.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-broker-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

describe("CredentialBroker", () => {
  let broker: CredentialBroker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "broker-test-"));
    _setMetadataPath(join(tmpDir, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("authorize", () => {
    test("denies when no credential metadata exists", () => {
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("No credential found");
      }
    });

    test("authorizes when tool is in allowedTools", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.token.service).toBe("github");
        expect(result.token.field).toBe("token");
        expect(result.token.toolName).toBe("browser_fill_credential");
        expect(result.token.consumed).toBe(false);
        expect(result.token.tokenId).toBeTruthy();
      }
    });

    test("denies when tool is not in allowedTools", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["other_tool"],
      });
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("not allowed");
        expect(result.reason).toContain("browser_fill_credential");
        expect(result.reason).toContain("Allowed tools: other_tool");
      }
    });

    test("denies when allowedTools is empty (fail-closed)", () => {
      upsertCredentialMetadata("github", "token");
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("not allowed");
        expect(result.reason).toContain("No tools are currently allowed");
        expect(result.reason).toContain("assistant credentials set");
      }
    });

    test("issues unique token IDs", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["tool1", "tool2"],
      });
      const r1 = broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool1",
      });
      const r2 = broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool2",
      });
      expect(r1.authorized).toBe(true);
      expect(r2.authorized).toBe(true);
      if (r1.authorized && r2.authorized) {
        expect(r1.token.tokenId).not.toBe(r2.token.tokenId);
      }
    });
  });

  describe("consume", () => {
    test("returns storage key on first consumption", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const auth = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(auth.authorized).toBe(true);
      if (!auth.authorized) return;

      const result = broker.consume(auth.token.tokenId);
      expect(result.success).toBe(true);
      expect(result.storageKey).toBe(credentialKey("github", "token"));
    });

    test("rejects double consumption", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const auth = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      if (!auth.authorized) return;

      broker.consume(auth.token.tokenId);
      const result = broker.consume(auth.token.tokenId);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("already consumed");
    });

    test("rejects unknown token ID", () => {
      const result = broker.consume("nonexistent-token");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("revoke", () => {
    test("revokes existing token", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const auth = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      if (!auth.authorized) return;

      expect(broker.revoke(auth.token.tokenId)).toBe(true);
      // After revocation, consume should fail
      const result = broker.consume(auth.token.tokenId);
      expect(result.success).toBe(false);
    });

    test("returns false for unknown token", () => {
      expect(broker.revoke("nonexistent")).toBe(false);
    });
  });

  describe("revokeAll", () => {
    test("clears all active tokens", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["tool1", "tool2"],
      });
      broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool1",
      });
      broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool2",
      });
      expect(broker.activeTokenCount).toBe(2);

      broker.revokeAll();
      expect(broker.activeTokenCount).toBe(0);
    });
  });

  describe("activeTokenCount", () => {
    test("counts only unconsumed tokens", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["tool1", "tool2"],
      });
      const auth1 = broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool1",
      });
      broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool2",
      });
      expect(broker.activeTokenCount).toBe(2);

      if (auth1.authorized) {
        broker.consume(auth1.token.tokenId);
      }
      expect(broker.activeTokenCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Behavior that reads stored secret values, exercised against the encrypted
// store backend (transient injection, multi-template serverUseById, revokeAll,
// and canonical/legacy capability-key resolution).
// ---------------------------------------------------------------------------

describe("CredentialBroker (encrypted store backend)", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    setStorePathForTesting(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    setStorePathForTesting(null);
    _resetBackend();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("transient credentials", () => {
    test("consume returns transient value and deletes it", () => {
      // GIVEN a credential with metadata and an injected one-time transient value
      upsertCredentialMetadata("svc", "key", { allowedTools: ["tool1"] });
      broker.injectTransient("svc", "key", "one-time-secret");

      // WHEN the credential is authorized and consumed
      const auth = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "tool1",
      });
      expect(auth.authorized).toBe(true);
      if (!auth.authorized) return;
      const result = broker.consume(auth.token.tokenId);

      // THEN the transient value is returned alongside the storage key
      expect(result.success).toBe(true);
      expect(result.value).toBe("one-time-secret");
      expect(result.storageKey).toBe(credentialKey("svc", "key"));

      // AND a subsequent authorize+consume no longer has the transient value
      const auth2 = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "tool1",
      });
      expect(auth2.authorized).toBe(true);
      if (!auth2.authorized) return;
      const result2 = broker.consume(auth2.token.tokenId);
      expect(result2.success).toBe(true);
      expect(result2.value).toBeUndefined();
    });

    test("browserFill uses transient value when available", async () => {
      // GIVEN a credential with a transient value and no stored value
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      broker.injectTransient("github", "token", "transient-ghp-123");

      // WHEN browserFill runs
      let filledValue: string | undefined;
      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filledValue = v;
        },
      });

      // THEN the transient value is filled
      expect(result.success).toBe(true);
      expect(filledValue).toBe("transient-ghp-123");
    });

    test("browserFill consumes transient value — second fill falls back to stored", async () => {
      // GIVEN a credential with both a stored value and a transient value
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "stored-value");
      broker.injectTransient("github", "token", "transient-value");

      // WHEN browserFill runs twice
      let filled1: string | undefined;
      await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filled1 = v;
        },
      });
      let filled2: string | undefined;
      await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filled2 = v;
        },
      });

      // THEN the first fill uses the transient and the second falls back to stored
      expect(filled1).toBe("transient-value");
      expect(filled2).toBe("stored-value");
    });

    test("browserFill preserves transient value on fill failure", async () => {
      // GIVEN a credential with a transient value
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      broker.injectTransient("github", "token", "transient-preserved");

      // WHEN the first fill throws
      const result1 = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async () => {
          throw new Error("Playwright timeout");
        },
      });
      expect(result1.success).toBe(false);
      let filled: string | undefined;
      const result2 = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filled = v;
        },
      });

      // THEN the transient value survives for the second fill
      expect(result2.success).toBe(true);
      expect(filled).toBe("transient-preserved");
    });

    test("serverUse uses transient value when available", async () => {
      // GIVEN a credential with a transient value
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["deploy"],
      });
      broker.injectTransient("vercel", "api_token", "transient-vercel-tok");

      // WHEN serverUse runs
      const result = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "deploy",
        execute: async (v) => {
          expect(v).toBe("transient-vercel-tok");
          return "deployed";
        },
      });

      // THEN the transient value is used for execution
      expect(result.success).toBe(true);
      expect(result.result).toBe("deployed");
    });

    test("serverUse consumes transient — subsequent call has no value without stored key", async () => {
      // GIVEN a credential with only a transient value (no stored value)
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["deploy"],
      });
      broker.injectTransient("vercel", "api_token", "transient-only");

      // WHEN serverUse runs twice
      await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "deploy",
        execute: async () => "ok",
      });
      const result = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "deploy",
        execute: async () => {
          throw new Error("should not be called");
        },
      });

      // THEN the second call fails because no stored value remains
      expect(result.success).toBe(false);
      expect(result.reason).toContain("no stored value");
    });

    test("injectTransient replaces previous transient for same key", () => {
      // GIVEN two transient values injected for the same credential
      upsertCredentialMetadata("svc", "key", { allowedTools: ["t"] });
      broker.injectTransient("svc", "key", "first");
      broker.injectTransient("svc", "key", "second");

      // WHEN the credential is authorized and consumed
      const auth = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "t",
      });
      if (!auth.authorized) return;
      const result = broker.consume(auth.token.tokenId);

      // THEN the most recent transient value wins
      expect(result.value).toBe("second");
    });

    test("transient value for one credential does not affect another", () => {
      // GIVEN a transient value injected for svcA only
      upsertCredentialMetadata("svcA", "key", { allowedTools: ["t"] });
      upsertCredentialMetadata("svcB", "key", { allowedTools: ["t"] });
      broker.injectTransient("svcA", "key", "val-a");

      // WHEN both credentials are authorized and consumed
      const authB = broker.authorize({
        service: "svcB",
        field: "key",
        toolName: "t",
      });
      if (!authB.authorized) return;
      const resultB = broker.consume(authB.token.tokenId);
      const authA = broker.authorize({
        service: "svcA",
        field: "key",
        toolName: "t",
      });
      if (!authA.authorized) return;
      const resultA = broker.consume(authA.token.tokenId);

      // THEN only svcA carries the transient value
      expect(resultB.success).toBe(true);
      expect(resultB.value).toBeUndefined();
      expect(resultA.value).toBe("val-a");
    });
  });

  describe("serverUseById edge cases", () => {
    test("serverUseById with multiple injection templates returns all", async () => {
      // GIVEN a credential with two injection templates and a stored value
      const meta = upsertCredentialMetadata("multi", "api_key", {
        allowedTools: ["proxy"],
        injectionTemplates: [
          {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Key ",
          },
          {
            hostPattern: "gateway.fal.ai",
            injectionType: "header",
            headerName: "X-Fal-Key",
          },
        ],
      });
      await setSecureKeyAsync(
        credentialKey("multi", "api_key"),
        "multi-secret",
      );

      // WHEN serverUseById resolves the credential by id
      const result = await broker.serverUseById({
        credentialId: meta.credentialId,
        requestingTool: "proxy",
      });

      // THEN both injection templates are returned without leaking the secret
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.injectionTemplates).toHaveLength(2);
      expect(result.injectionTemplates[0].hostPattern).toBe("*.fal.ai");
      expect(result.injectionTemplates[1].hostPattern).toBe("gateway.fal.ai");
      expect(JSON.stringify(result)).not.toContain("multi-secret");
    });
  });

  describe("revokeAll", () => {
    test("revokeAll clears all tokens and subsequent consume fails", () => {
      // GIVEN two active tokens for a credential
      upsertCredentialMetadata("svc", "key", { allowedTools: ["t1", "t2"] });
      const a1 = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "t1",
      });
      const a2 = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "t2",
      });
      expect(broker.activeTokenCount).toBe(2);

      // WHEN revokeAll is called
      broker.revokeAll();

      // THEN the token count is zero and consuming either token fails
      expect(broker.activeTokenCount).toBe(0);
      if (a1.authorized) {
        expect(broker.consume(a1.token.tokenId).success).toBe(false);
      }
      if (a2.authorized) {
        expect(broker.consume(a2.token.tokenId).success).toBe(false);
      }
    });

    test("revokeAll on empty broker is a no-op", () => {
      // GIVEN a broker with no active tokens
      expect(broker.activeTokenCount).toBe(0);

      // WHEN revokeAll is called
      broker.revokeAll();

      // THEN the token count remains zero
      expect(broker.activeTokenCount).toBe(0);
    });
  });

  describe("canonical capability key", () => {
    test("authorize succeeds with canonical key when metadata has canonical key", () => {
      // GIVEN metadata allowing the canonical browser-fill capability key
      upsertCredentialMetadata("github", "token", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });

      // WHEN authorizing with the canonical key
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
      });

      // THEN authorization succeeds
      expect(result.authorized).toBe(true);
    });

    test("authorize succeeds with canonical key when metadata has legacy alias", () => {
      // GIVEN metadata stored under the legacy browser_fill_credential alias
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });

      // WHEN authorizing with the canonical key
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
      });

      // THEN authorization succeeds
      expect(result.authorized).toBe(true);
    });

    test("authorize succeeds with legacy alias when metadata has canonical key", () => {
      // GIVEN metadata allowing the canonical capability key
      upsertCredentialMetadata("github", "token", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });

      // WHEN authorizing with the legacy alias
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });

      // THEN authorization succeeds
      expect(result.authorized).toBe(true);
    });

    test("serverUse with canonical key works when metadata has legacy alias", async () => {
      // GIVEN metadata stored under the legacy alias with a stored value
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(
        credentialKey("vercel", "api_token"),
        "vercel-tok",
      );

      // WHEN serverUse runs with the canonical key
      const result = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: BROWSER_FILL_CAPABILITY,
        execute: async (v) => v,
      });

      // THEN execution succeeds with the stored value
      expect(result.success).toBe(true);
      expect(result.result).toBe("vercel-tok");
    });

    test("non-aliased tool names are unaffected by alias resolution", () => {
      // GIVEN metadata allowing a non-aliased custom tool
      upsertCredentialMetadata("svc", "key", {
        allowedTools: ["custom_tool"],
      });

      // WHEN authorizing with that custom tool
      const result = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "custom_tool",
      });

      // THEN authorization succeeds
      expect(result.authorized).toBe(true);
    });

    test("non-aliased tool denied when only canonical key is allowed", () => {
      // GIVEN metadata allowing only the canonical capability key
      upsertCredentialMetadata("svc", "key", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });

      // WHEN authorizing with an unrelated tool
      const result = broker.authorize({
        service: "svc",
        field: "key",
        toolName: "unrelated_tool",
      });

      // THEN authorization is denied
      expect(result.authorized).toBe(false);
    });
  });
});
