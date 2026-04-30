import { describe, expect, test } from "bun:test";

import { apiKeyToCredentialsMigration } from "../migrations/002-api-keys-to-credentials.js";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory SecureKeyBackend backed by a Map<string, string>.
 * Allows us to assert state before/after migration without relying on mocked
 * function call tracking.
 */
function makeMapBackend(
  initial: Record<string, string> = {},
): SecureKeyBackend & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: (_key: string) => Promise.resolve(store.get(_key)),
    set: (_key: string, value: string) => {
      store.set(_key, value);
      return Promise.resolve(true);
    },
    delete: (_key: string) => {
      const existed = store.has(_key);
      store.delete(_key);
      return Promise.resolve({ deleted: existed });
    },
    list: () => Promise.resolve([...store.keys()]),
  } as unknown as SecureKeyBackend & { store: Map<string, string> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apiKeyToCredentialsMigration (002)", () => {
  // -------------------------------------------------------------------------
  // run()
  // -------------------------------------------------------------------------

  describe("run()", () => {
    test("bare key present — writes credential key and deletes bare key", async () => {
      const backend = makeMapBackend({ anthropic: "sk-ant-123" });

      await apiKeyToCredentialsMigration.run(backend);

      expect(backend.store.get("credential/anthropic/api_key")).toBe(
        "sk-ant-123",
      );
      expect(backend.store.has("anthropic")).toBe(false);
    });

    test("idempotent — credential key already exists: bare key deleted, credential value unchanged", async () => {
      const backend = makeMapBackend({
        anthropic: "sk-ant-new",
        "credential/anthropic/api_key": "sk-ant-existing",
      });

      await apiKeyToCredentialsMigration.run(backend);

      // Credential key must NOT be overwritten
      expect(backend.store.get("credential/anthropic/api_key")).toBe(
        "sk-ant-existing",
      );
      // Bare key must be removed
      expect(backend.store.has("anthropic")).toBe(false);
    });

    test("no bare key for provider — no write and no delete for that provider", async () => {
      // Store only has a key for openai; anthropic has nothing
      const backend = makeMapBackend({ openai: "sk-openai-abc" });

      await apiKeyToCredentialsMigration.run(backend);

      // openai should be migrated
      expect(backend.store.get("credential/openai/api_key")).toBe(
        "sk-openai-abc",
      );
      expect(backend.store.has("openai")).toBe(false);

      // anthropic: credential key should NOT exist (no accidental write)
      expect(backend.store.has("credential/anthropic/api_key")).toBe(false);
    });

    test("multiple providers — each handled independently", async () => {
      const backend = makeMapBackend({
        anthropic: "sk-ant-multi",
        openai: "sk-openai-multi",
        gemini: "gemini-key",
        brave: "brave-key",
      });

      await apiKeyToCredentialsMigration.run(backend);

      // All bare keys gone
      for (const provider of ["anthropic", "openai", "gemini", "brave"]) {
        expect(backend.store.has(provider)).toBe(false);
      }

      // All credential keys present
      expect(backend.store.get("credential/anthropic/api_key")).toBe(
        "sk-ant-multi",
      );
      expect(backend.store.get("credential/openai/api_key")).toBe(
        "sk-openai-multi",
      );
      expect(backend.store.get("credential/gemini/api_key")).toBe("gemini-key");
      expect(backend.store.get("credential/brave/api_key")).toBe("brave-key");

      // Providers that had no bare key should have no credential key
      for (const provider of [
        "ollama",
        "fireworks",
        "openrouter",
        "perplexity",
        "deepgram",
        "xai",
      ]) {
        expect(backend.store.has(`credential/${provider}/api_key`)).toBe(false);
      }
    });

    test("set() failure — throws so runner marks migration failed and retries", async () => {
      const backend = makeMapBackend({ anthropic: "sk-ant-123" });
      backend.set = (_key: string, _value: string) => Promise.resolve(false);

      await expect(apiKeyToCredentialsMigration.run(backend)).rejects.toThrow(
        "Migration 002: failed to write credential/anthropic/api_key",
      );

      // Bare key must survive — delete was never reached
      expect(backend.store.get("anthropic")).toBe("sk-ant-123");
    });

    test("run() is idempotent — running twice leaves store in same state as once", async () => {
      const backend = makeMapBackend({
        anthropic: "sk-ant-idem",
        openai: "sk-openai-idem",
      });

      await apiKeyToCredentialsMigration.run(backend);
      // Capture state after first run
      const afterFirst = new Map(backend.store);

      await apiKeyToCredentialsMigration.run(backend);
      // State after second run must match first run
      expect(backend.store).toEqual(afterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // down()
  // -------------------------------------------------------------------------

  describe("down()", () => {
    test("reverses a migrated key back to bare name", async () => {
      const backend = makeMapBackend({
        "credential/anthropic/api_key": "sk-ant-rev",
      });

      await apiKeyToCredentialsMigration.down(backend);

      expect(backend.store.get("anthropic")).toBe("sk-ant-rev");
      expect(backend.store.has("credential/anthropic/api_key")).toBe(false);
    });

    test("set() failure — throws so runner marks rollback failed and preserves credential key", async () => {
      const backend = makeMapBackend({
        "credential/anthropic/api_key": "sk-ant-rev",
      });
      backend.set = (_key: string, _value: string) => Promise.resolve(false);

      await expect(apiKeyToCredentialsMigration.down(backend)).rejects.toThrow(
        "Migration 002 rollback: failed to restore bare key anthropic",
      );

      // Credential key must survive — delete was never reached
      expect(backend.store.get("credential/anthropic/api_key")).toBe(
        "sk-ant-rev",
      );
    });

    test("idempotent — bare key already exists: credential key deleted, bare key value unchanged", async () => {
      const backend = makeMapBackend({
        "credential/anthropic/api_key": "sk-ant-cred",
        anthropic: "sk-ant-original",
      });

      await apiKeyToCredentialsMigration.down(backend);

      // Bare key value must NOT be overwritten
      expect(backend.store.get("anthropic")).toBe("sk-ant-original");
      // Credential key must be removed
      expect(backend.store.has("credential/anthropic/api_key")).toBe(false);
    });
  });
});
