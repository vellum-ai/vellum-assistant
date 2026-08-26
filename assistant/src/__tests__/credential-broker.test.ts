import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

describe("CredentialBroker (encrypted store backend)", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
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
    test("browserFill uses transient value when available", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      broker.injectTransient("github", "token", "transient-ghp-123");

      let filledValue: string | undefined;
      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          filledValue = v;
        },
      });

      expect(result.success).toBe(true);
      expect(filledValue).toBe("transient-ghp-123");
    });

    test("browserFill consumes transient value — second fill falls back to stored", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "stored-value");
      broker.injectTransient("github", "token", "transient-value");

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

      expect(filled1).toBe("transient-value");
      expect(filled2).toBe("stored-value");
    });

    test("browserFill preserves transient value on fill failure", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      broker.injectTransient("github", "token", "transient-preserved");

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

      expect(result2.success).toBe(true);
      expect(filled).toBe("transient-preserved");
    });

    test("serverUse uses transient value when available", async () => {
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["deploy"],
      });
      broker.injectTransient("vercel", "api_token", "transient-vercel-tok");

      const result = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "deploy",
        execute: async (v) => {
          expect(v).toBe("transient-vercel-tok");
          return "deployed";
        },
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe("deployed");
    });

    test("serverUse consumes transient — subsequent call has no value without stored key", async () => {
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["deploy"],
      });
      broker.injectTransient("vercel", "api_token", "transient-only");

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

      expect(result.success).toBe(false);
      expect(result.reason).toContain("no stored value");
    });

    test("injectTransient replaces previous transient for same key", async () => {
      upsertCredentialMetadata("svc", "key", { allowedTools: ["t"] });
      broker.injectTransient("svc", "key", "first");
      broker.injectTransient("svc", "key", "second");

      const result = await broker.serverUse({
        service: "svc",
        field: "key",
        toolName: "t",
        execute: async (v) => v,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe("second");
    });

    test("transient value for one credential does not affect another", async () => {
      upsertCredentialMetadata("svcA", "key", { allowedTools: ["t"] });
      upsertCredentialMetadata("svcB", "key", { allowedTools: ["t"] });
      await setSecureKeyAsync(credentialKey("svcB", "key"), "stored-b");
      broker.injectTransient("svcA", "key", "val-a");

      const resultB = await broker.serverUse({
        service: "svcB",
        field: "key",
        toolName: "t",
        execute: async (v) => v,
      });
      const resultA = await broker.serverUse({
        service: "svcA",
        field: "key",
        toolName: "t",
        execute: async (v) => v,
      });

      expect(resultB.success).toBe(true);
      expect(resultB.result).toBe("stored-b");
      expect(resultA.success).toBe(true);
      expect(resultA.result).toBe("val-a");
    });
  });

  describe("canonical capability key", () => {
    test("browserFill succeeds with canonical key when metadata has canonical key", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret");

      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
        fill: async () => {},
      });

      expect(result.success).toBe(true);
    });

    test("browserFill succeeds with canonical key when metadata has legacy alias", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret");

      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: BROWSER_FILL_CAPABILITY,
        fill: async () => {},
      });

      expect(result.success).toBe(true);
    });

    test("browserFill succeeds with legacy alias when metadata has canonical key", async () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });
      await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret");

      const result = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        fill: async () => {},
      });

      expect(result.success).toBe(true);
    });

    test("serverUse with canonical key works when metadata has legacy alias", async () => {
      upsertCredentialMetadata("vercel", "api_token", {
        allowedTools: ["browser_fill_credential"],
      });
      await setSecureKeyAsync(
        credentialKey("vercel", "api_token"),
        "vercel-tok",
      );

      const result = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: BROWSER_FILL_CAPABILITY,
        execute: async (v) => v,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe("vercel-tok");
    });

    test("non-aliased tool names are unaffected by alias resolution", async () => {
      upsertCredentialMetadata("svc", "key", {
        allowedTools: ["custom_tool"],
      });
      await setSecureKeyAsync(credentialKey("svc", "key"), "secret");

      const result = await broker.serverUse({
        service: "svc",
        field: "key",
        toolName: "custom_tool",
        execute: async (v) => v,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe("secret");
    });

    test("non-aliased tool denied when only canonical key is allowed", async () => {
      upsertCredentialMetadata("svc", "key", {
        allowedTools: [BROWSER_FILL_CAPABILITY],
      });
      await setSecureKeyAsync(credentialKey("svc", "key"), "secret");

      const result = await broker.serverUse({
        service: "svc",
        field: "key",
        toolName: "unrelated_tool",
        execute: async () => {
          throw new Error("should not be called");
        },
      });

      expect(result.success).toBe(false);
    });
  });
});
