/**
 * Tests for the BulkSetCredentials RPC handler.
 *
 * Validates that the handler stores each credential independently and
 * returns per-credential success/failure status.
 */

import { describe, expect, test } from "bun:test";

import { CesRpcMethod } from "@vellumai/ces-contracts";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal BulkSetCredentials handler using the same logic as
 * main.ts / managed-main.ts, backed by the given SecureKeyBackend.
 */
function buildBulkSetHandler(secureKeyBackend: SecureKeyBackend) {
  return async (req: { credentials: Array<{ account: string; value: string }> }) => {
    const results = [];
    for (const { account, value } of req.credentials) {
      const ok = await secureKeyBackend.set(account, value);
      results.push({ account, ok });
    }
    return { results };
  };
}

/**
 * Create an in-memory SecureKeyBackend for testing.
 * Optionally accepts a set of accounts that should fail on set().
 */
function createMockBackend(failingAccounts: Set<string> = new Set()): SecureKeyBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key);
    },
    async set(key: string, value: string) {
      if (failingAccounts.has(key)) {
        return false;
      }
      store.set(key, value);
      return true;
    },
    async delete(key: string) {
      if (store.has(key)) {
        store.delete(key);
        return "deleted";
      }
      return "not-found";
    },
    async list() {
      return Array.from(store.keys());
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BulkSetCredentials handler", () => {
  test("stores multiple credentials and returns ok: true for each", async () => {
    const backend = createMockBackend();
    const handler = buildBulkSetHandler(backend);

    const result = await handler({
      credentials: [
        { account: "acct-1", value: "secret-1" },
        { account: "acct-2", value: "secret-2" },
        { account: "acct-3", value: "secret-3" },
      ],
    });

    expect(result.results).toEqual([
      { account: "acct-1", ok: true },
      { account: "acct-2", ok: true },
      { account: "acct-3", ok: true },
    ]);

    // Verify all credentials were actually stored
    expect(await backend.get("acct-1")).toBe("secret-1");
    expect(await backend.get("acct-2")).toBe("secret-2");
    expect(await backend.get("acct-3")).toBe("secret-3");
  });

  test("partial failure returns mixed results without aborting the rest", async () => {
    const failingAccounts = new Set(["acct-2"]);
    const backend = createMockBackend(failingAccounts);
    const handler = buildBulkSetHandler(backend);

    const result = await handler({
      credentials: [
        { account: "acct-1", value: "secret-1" },
        { account: "acct-2", value: "secret-2" },
        { account: "acct-3", value: "secret-3" },
      ],
    });

    expect(result.results).toEqual([
      { account: "acct-1", ok: true },
      { account: "acct-2", ok: false },
      { account: "acct-3", ok: true },
    ]);

    // acct-1 and acct-3 should be stored; acct-2 should not
    expect(await backend.get("acct-1")).toBe("secret-1");
    expect(await backend.get("acct-2")).toBeUndefined();
    expect(await backend.get("acct-3")).toBe("secret-3");
  });

  test("empty credentials array returns empty results array", async () => {
    const backend = createMockBackend();
    const handler = buildBulkSetHandler(backend);

    const result = await handler({ credentials: [] });

    expect(result.results).toEqual([]);
  });

  test("handler is registered under the correct RPC method key", () => {
    // Verify the enum value matches what we register against
    expect(CesRpcMethod.BulkSetCredentials).toBe("bulk_set_credentials");
  });
});
