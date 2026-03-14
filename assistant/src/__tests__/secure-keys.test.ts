import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
// Mock logger (no-op — compatible with other test files' identical mock)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Broker client mock — set up before importing secure-keys so the
// module-level `createBrokerClient()` call picks up our mock.
// ---------------------------------------------------------------------------

let mockBrokerAvailable = false;
let mockBrokerStore: Map<string, string> = new Map();
let mockBrokerGetError = false;
let mockBrokerSetError = false;
let mockBrokerDelError = false;
let mockBrokerGetCalled = false;

mock.module("../security/keychain-broker-client.js", () => ({
  createBrokerClient: () => ({
    isAvailable: () => mockBrokerAvailable,
    ping: async () => (mockBrokerAvailable ? { pong: true } : null),
    get: async (account: string) => {
      mockBrokerGetCalled = true;
      // null = broker error (fall back to encrypted store)
      if (mockBrokerGetError) return null;
      const value = mockBrokerStore.get(account);
      if (value !== undefined) return { found: true, value };
      return { found: false };
    },
    set: async (account: string, value: string) => {
      if (mockBrokerSetError)
        return {
          status: "rejected" as const,
          code: "KEYCHAIN_ERROR",
          message: "mock error",
        };
      mockBrokerStore.set(account, value);
      return { status: "ok" as const };
    },
    del: async (account: string) => {
      if (mockBrokerDelError) return false;
      const existed = mockBrokerStore.has(account);
      mockBrokerStore.delete(account);
      return existed;
    },
    list: async () => Array.from(mockBrokerStore.keys()),
  }),
}));

import { _setStorePath } from "../security/encrypted-store.js";
import {
  _resetBackend,
  _setBackend,
  deleteSecureKeyAsync,
  getBackendType,
  getSecureKeyAsync,
  isDowngradedFromKeychain,
  listSecureKeys,
  setSecureKeyAsync,
} from "../security/secure-keys.js";

// ---------------------------------------------------------------------------
// Use a temp directory for encrypted store tests
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-seckeys-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

describe("secure-keys", () => {
  beforeEach(() => {
    _resetBackend();

    // Reset broker mock state
    mockBrokerAvailable = false;
    mockBrokerStore = new Map();
    mockBrokerGetError = false;
    mockBrokerSetError = false;
    mockBrokerDelError = false;
    mockBrokerGetCalled = false;

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
  });

  afterEach(() => {
    _setStorePath(null);
    _resetBackend();
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -----------------------------------------------------------------------
  // Backend selection
  // -----------------------------------------------------------------------
  describe("backend selection", () => {
    test("returns encrypted when broker is unavailable", () => {
      expect(getBackendType()).toBe("encrypted");
    });

    test("returns broker when broker is available", () => {
      mockBrokerAvailable = true;
      expect(getBackendType()).toBe("broker");
    });

    test("isDowngradedFromKeychain always returns false", () => {
      expect(isDowngradedFromKeychain()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // CRUD operations (via encrypted store backend — async)
  // -----------------------------------------------------------------------
  describe("CRUD with encrypted backend (async)", () => {
    test("set and get a key", async () => {
      await setSecureKeyAsync("openai", "sk-openai-789");
      expect(await getSecureKeyAsync("openai")).toBe("sk-openai-789");
    });

    test("get returns undefined for nonexistent key", async () => {
      expect(await getSecureKeyAsync("nonexistent")).toBeUndefined();
    });

    test("delete removes a key", async () => {
      await setSecureKeyAsync("gemini", "gem-key");
      expect(await deleteSecureKeyAsync("gemini")).toBe("deleted");
      expect(await getSecureKeyAsync("gemini")).toBeUndefined();
    });

    test("delete returns not-found for nonexistent key", async () => {
      expect(await deleteSecureKeyAsync("missing")).toBe("not-found");
    });

    test("listSecureKeys returns all keys", async () => {
      await setSecureKeyAsync("anthropic", "val1");
      await setSecureKeyAsync("openai", "val2");
      const keys = listSecureKeys();
      expect(keys).toContain("anthropic");
      expect(keys).toContain("openai");
      expect(keys.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Async variants — broker available path
  // -----------------------------------------------------------------------
  describe("async variants with broker available", () => {
    test("getSecureKeyAsync returns encrypted store value when both stores have key", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "broker-value");
      await setSecureKeyAsync("api-key", "encrypted-value");
      // Encrypted store is checked first — broker is never called
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
      expect(mockBrokerGetCalled).toBe(false);
    });

    test("getSecureKeyAsync returns encrypted store value without calling broker", async () => {
      mockBrokerAvailable = true;
      // Only encrypted store has the key — broker has nothing.
      // Encrypted store is checked first, so broker.get() is never called.
      await setSecureKeyAsync("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
      expect(mockBrokerGetCalled).toBe(false);
    });

    test("getSecureKeyAsync returns undefined when neither broker nor encrypted store has key", async () => {
      mockBrokerAvailable = true;
      // Neither store has the key — should return undefined
      expect(await getSecureKeyAsync("missing-key")).toBeUndefined();
    });

    test("getSecureKeyAsync returns encrypted store value even when broker would error", async () => {
      mockBrokerAvailable = true;
      mockBrokerGetError = true;
      // Encrypted store hit short-circuits — broker is never called, so
      // the broker error flag is irrelevant.
      await setSecureKeyAsync("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
      expect(mockBrokerGetCalled).toBe(false);
    });

    test("setSecureKeyAsync writes to broker and encrypted store", async () => {
      mockBrokerAvailable = true;
      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(mockBrokerStore.get("api-key")).toBe("new-value");
      // Also persisted to encrypted store
      expect(await getSecureKeyAsync("api-key")).toBe("new-value");
    });

    test("setSecureKeyAsync returns false on broker set error (no silent fallback)", async () => {
      mockBrokerAvailable = true;
      mockBrokerSetError = true;
      const result = await setSecureKeyAsync("api-key", "new-value");
      // Must return false — falling through to encrypted-only write would
      // leave the broker with stale data that async readers still see.
      expect(result).toBe(false);
      expect(mockBrokerStore.has("api-key")).toBe(false);
      // Encrypted store should NOT have been written either.
      expect(await getSecureKeyAsync("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync deletes from broker and encrypted store", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "broker-value");
      await setSecureKeyAsync("api-key", "encrypted-value");
      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(mockBrokerStore.has("api-key")).toBe(false);
      expect(await getSecureKeyAsync("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync returns error on broker del error (no silent fallback)", async () => {
      mockBrokerAvailable = true;
      mockBrokerDelError = true;
      await setSecureKeyAsync("api-key", "encrypted-value");
      const result = await deleteSecureKeyAsync("api-key");
      // Must return "error" — falling through to encrypted-only delete would
      // leave the broker with the key, and async readers would still see it.
      expect(result).toBe("error");
      // Encrypted store should NOT have been modified either.
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
    });
  });

  // -----------------------------------------------------------------------
  // Async variants — broker unavailable path
  // -----------------------------------------------------------------------
  describe("async variants with broker unavailable", () => {
    test("getSecureKeyAsync uses encrypted store", async () => {
      await setSecureKeyAsync("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
    });

    test("getSecureKeyAsync returns undefined for missing key", async () => {
      expect(await getSecureKeyAsync("missing")).toBeUndefined();
    });

    test("setSecureKeyAsync uses encrypted store", async () => {
      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(await getSecureKeyAsync("api-key")).toBe("new-value");
    });

    test("deleteSecureKeyAsync uses encrypted store", async () => {
      await setSecureKeyAsync("api-key", "value");
      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(await getSecureKeyAsync("api-key")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Encrypted-store-first read order
  // -----------------------------------------------------------------------
  describe("encrypted-store-first read order", () => {
    test("returns value from encrypted store without calling broker", async () => {
      mockBrokerAvailable = true;
      await setSecureKeyAsync("test-account", "test-secret");
      mockBrokerStore.set("test-account", "broker-secret");

      const result = await getSecureKeyAsync("test-account");
      expect(result).toBe("test-secret");
      // Broker should never have been called — encrypted store hit
      // short-circuits the lookup.
      expect(mockBrokerGetCalled).toBe(false);
    });

    test("falls back to broker when encrypted store returns undefined", async () => {
      mockBrokerAvailable = true;
      // Encrypted store has nothing for this key
      mockBrokerStore.set("test-account", "broker-secret");

      const result = await getSecureKeyAsync("test-account");
      expect(result).toBe("broker-secret");
      // Broker should have been called as fallback
      expect(mockBrokerGetCalled).toBe(true);
    });

    test("returns undefined when neither store has the key", async () => {
      mockBrokerAvailable = true;
      // Neither encrypted store nor broker has the key

      const result = await getSecureKeyAsync("test-account");
      expect(result).toBeUndefined();
    });

    test("returns undefined without broker call when broker unavailable and encrypted store empty", async () => {
      // Broker is unavailable (default state), encrypted store is empty
      mockBrokerAvailable = false;

      const result = await getSecureKeyAsync("test-account");
      expect(result).toBeUndefined();
      // Broker.get() should not have been called since broker is unavailable
      expect(mockBrokerGetCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Stale-value prevention — encrypted-store-first reads avoid stale broker data
  // -----------------------------------------------------------------------
  describe("stale-value prevention", () => {
    test("setSecureKeyAsync updates both stores so encrypted-store-first read returns new value", async () => {
      mockBrokerAvailable = true;
      // Simulate broker holding an old value
      mockBrokerStore.set("api-key", "old-broker-value");
      await setSecureKeyAsync("api-key", "old-encrypted-value");

      // Update via async path (writes both broker + encrypted)
      const ok = await setSecureKeyAsync("api-key", "new-value");
      expect(ok).toBe(true);

      // Encrypted-store-first read returns the new value
      const value = await getSecureKeyAsync("api-key");
      expect(value).toBe("new-value");
      // Both stores should agree
      expect(mockBrokerStore.get("api-key")).toBe("new-value");
      expect(await getSecureKeyAsync("api-key")).toBe("new-value");
    });

    test("deleteSecureKeyAsync removes from both stores so read returns undefined", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "old-broker-value");
      await setSecureKeyAsync("api-key", "old-encrypted-value");

      // Delete via async path (deletes from both broker + encrypted)
      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");

      // Neither store has the key — returns undefined
      const value = await getSecureKeyAsync("api-key");
      expect(value).toBeUndefined();
    });

    test("setSecureKeyAsync updates encrypted store — encrypted-store-first read returns fresh value", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "old-broker-value");

      // Async write updates both broker and encrypted store
      await setSecureKeyAsync("api-key", "new-encrypted-value");

      // Encrypted-store-first read returns the fresh encrypted value
      const value = await getSecureKeyAsync("api-key");
      expect(value).toBe("new-encrypted-value");
      expect(mockBrokerGetCalled).toBe(false);
    });

    test("setSecureKeyAsync failure leaves both stores unchanged", async () => {
      mockBrokerAvailable = true;
      mockBrokerSetError = true;
      mockBrokerStore.set("api-key", "original-value");
      // Pre-seed encrypted store directly via broker mock bypass:
      // We need the encrypted store to have the value before testing failure.
      // Temporarily disable broker error to seed, then re-enable.
      mockBrokerSetError = false;
      await setSecureKeyAsync("api-key", "original-value");
      mockBrokerSetError = true;

      const ok = await setSecureKeyAsync("api-key", "new-value");
      expect(ok).toBe(false);

      // Both stores should retain original value — no partial update
      expect(mockBrokerStore.get("api-key")).toBe("original-value");
      expect(await getSecureKeyAsync("api-key")).toBe("original-value");
    });

    test("deleteSecureKeyAsync failure leaves both stores unchanged", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "value");
      await setSecureKeyAsync("api-key", "value");
      mockBrokerDelError = true;

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("error");

      // Both stores should retain the key — no partial deletion
      expect(mockBrokerStore.has("api-key")).toBe(true);
      expect(await getSecureKeyAsync("api-key")).toBe("value");
    });
  });

  // -----------------------------------------------------------------------
  // _setBackend / _resetBackend (no-ops kept for test compat)
  // -----------------------------------------------------------------------
  describe("_setBackend", () => {
    test("_setBackend is a no-op but does not throw", async () => {
      _setBackend("encrypted");
      await setSecureKeyAsync("test", "value");
      expect(existsSync(STORE_PATH)).toBe(true);
    });

    test("_resetBackend is a no-op but does not throw", async () => {
      _resetBackend();
      await setSecureKeyAsync("test", "value");
      expect(await getSecureKeyAsync("test")).toBe("value");
    });
  });
});
