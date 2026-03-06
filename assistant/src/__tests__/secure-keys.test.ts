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

mock.module("../security/keychain-broker-client.js", () => ({
  createBrokerClient: () => ({
    isAvailable: () => mockBrokerAvailable,
    ping: async () => (mockBrokerAvailable ? { pong: true } : null),
    get: async (account: string) => {
      // null = broker error (fall back to encrypted store)
      if (mockBrokerGetError) return null;
      const value = mockBrokerStore.get(account);
      if (value !== undefined) return { found: true, value };
      return { found: false };
    },
    set: async (account: string, value: string) => {
      if (mockBrokerSetError) return false;
      mockBrokerStore.set(account, value);
      return true;
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
  deleteSecureKey,
  deleteSecureKeyAsync,
  getBackendType,
  getSecureKey,
  getSecureKeyAsync,
  isDowngradedFromKeychain,
  listSecureKeys,
  setSecureKey,
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
  // CRUD operations (via encrypted store backend — sync)
  // -----------------------------------------------------------------------
  describe("CRUD with encrypted backend (sync)", () => {
    test("set and get a key", () => {
      setSecureKey("openai", "sk-openai-789");
      expect(getSecureKey("openai")).toBe("sk-openai-789");
    });

    test("get returns undefined for nonexistent key", () => {
      expect(getSecureKey("nonexistent")).toBeUndefined();
    });

    test("delete removes a key", () => {
      setSecureKey("gemini", "gem-key");
      expect(deleteSecureKey("gemini")).toBe("deleted");
      expect(getSecureKey("gemini")).toBeUndefined();
    });

    test("delete returns not-found for nonexistent key", () => {
      expect(deleteSecureKey("missing")).toBe("not-found");
    });

    test("listSecureKeys returns all keys", () => {
      setSecureKey("anthropic", "val1");
      setSecureKey("openai", "val2");
      const keys = listSecureKeys();
      expect(keys).toContain("anthropic");
      expect(keys).toContain("openai");
      expect(keys.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Sync variants always use encrypted store even when broker is available
  // -----------------------------------------------------------------------
  describe("sync variants ignore broker", () => {
    test("getSecureKey uses encrypted store even when broker is available", () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "broker-value");
      // Sync getter should not see broker-only keys
      expect(getSecureKey("api-key")).toBeUndefined();
      // But encrypted store keys should work
      setSecureKey("api-key", "encrypted-value");
      expect(getSecureKey("api-key")).toBe("encrypted-value");
    });

    test("setSecureKey uses encrypted store even when broker is available", () => {
      mockBrokerAvailable = true;
      setSecureKey("api-key", "encrypted-value");
      expect(getSecureKey("api-key")).toBe("encrypted-value");
      // Should not have written to broker
      expect(mockBrokerStore.has("api-key")).toBe(false);
    });

    test("deleteSecureKey uses encrypted store even when broker is available", () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "broker-value");
      setSecureKey("api-key", "encrypted-value");
      deleteSecureKey("api-key");
      expect(getSecureKey("api-key")).toBeUndefined();
      // Broker value should be untouched
      expect(mockBrokerStore.has("api-key")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Async variants — broker available path
  // -----------------------------------------------------------------------
  describe("async variants with broker available", () => {
    test("getSecureKeyAsync returns broker value when available", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "broker-value");
      setSecureKey("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("broker-value");
    });

    test("getSecureKeyAsync falls back to encrypted store when broker reports not-found", async () => {
      mockBrokerAvailable = true;
      // Broker has nothing for this key — returns { found: false }.
      // Keys may exist only in the encrypted store (written while broker
      // was unavailable or via sync setSecureKey), so we must fall back.
      setSecureKey("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
    });

    test("getSecureKeyAsync returns undefined when neither broker nor encrypted store has key", async () => {
      mockBrokerAvailable = true;
      // Neither store has the key — should return undefined
      expect(await getSecureKeyAsync("missing-key")).toBeUndefined();
    });

    test("getSecureKeyAsync falls back to encrypted store on broker error", async () => {
      mockBrokerAvailable = true;
      mockBrokerGetError = true;
      setSecureKey("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
    });

    test("setSecureKeyAsync writes to broker and encrypted store", async () => {
      mockBrokerAvailable = true;
      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(mockBrokerStore.get("api-key")).toBe("new-value");
      // Also persisted to encrypted store for sync callers
      expect(getSecureKey("api-key")).toBe("new-value");
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
      expect(getSecureKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync deletes from broker and encrypted store", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "broker-value");
      setSecureKey("api-key", "encrypted-value");
      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(mockBrokerStore.has("api-key")).toBe(false);
      expect(getSecureKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync returns error on broker del error (no silent fallback)", async () => {
      mockBrokerAvailable = true;
      mockBrokerDelError = true;
      setSecureKey("api-key", "encrypted-value");
      const result = await deleteSecureKeyAsync("api-key");
      // Must return "error" — falling through to encrypted-only delete would
      // leave the broker with the key, and async readers would still see it.
      expect(result).toBe("error");
      // Encrypted store should NOT have been modified either.
      expect(getSecureKey("api-key")).toBe("encrypted-value");
    });
  });

  // -----------------------------------------------------------------------
  // Async variants — broker unavailable path
  // -----------------------------------------------------------------------
  describe("async variants with broker unavailable", () => {
    test("getSecureKeyAsync uses encrypted store", async () => {
      setSecureKey("api-key", "encrypted-value");
      expect(await getSecureKeyAsync("api-key")).toBe("encrypted-value");
    });

    test("getSecureKeyAsync returns undefined for missing key", async () => {
      expect(await getSecureKeyAsync("missing")).toBeUndefined();
    });

    test("setSecureKeyAsync uses encrypted store", async () => {
      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(getSecureKey("api-key")).toBe("new-value");
    });

    test("deleteSecureKeyAsync uses encrypted store", async () => {
      setSecureKey("api-key", "value");
      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(getSecureKey("api-key")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Stale-value prevention — broker-first reads after credential updates
  // -----------------------------------------------------------------------
  describe("stale-value prevention", () => {
    test("setSecureKeyAsync updates broker so broker-first read returns new value", async () => {
      mockBrokerAvailable = true;
      // Simulate broker holding an old value
      mockBrokerStore.set("api-key", "old-broker-value");
      setSecureKey("api-key", "old-encrypted-value");

      // Update via async path (writes both broker + encrypted)
      const ok = await setSecureKeyAsync("api-key", "new-value");
      expect(ok).toBe(true);

      // Broker-first read should return the new value, not stale old value
      const value = await getSecureKeyAsync("api-key");
      expect(value).toBe("new-value");
      // Both stores should agree
      expect(mockBrokerStore.get("api-key")).toBe("new-value");
      expect(getSecureKey("api-key")).toBe("new-value");
    });

    test("deleteSecureKeyAsync removes from broker so broker-first read falls through", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "old-broker-value");
      setSecureKey("api-key", "old-encrypted-value");

      // Delete via async path (deletes from both broker + encrypted)
      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");

      // Broker-first read should not find the key in either store
      const value = await getSecureKeyAsync("api-key");
      expect(value).toBeUndefined();
    });

    test("sync setSecureKey does NOT update broker — stale read demonstrates the problem", async () => {
      mockBrokerAvailable = true;
      mockBrokerStore.set("api-key", "old-broker-value");

      // Sync write only updates encrypted store, NOT broker
      setSecureKey("api-key", "new-encrypted-value");

      // Broker-first read still returns the stale broker value
      const value = await getSecureKeyAsync("api-key");
      expect(value).toBe("old-broker-value");
      // This is the exact bug that async migration fixes
    });

    test("setSecureKeyAsync failure leaves both stores unchanged", async () => {
      mockBrokerAvailable = true;
      mockBrokerSetError = true;
      mockBrokerStore.set("api-key", "original-value");
      setSecureKey("api-key", "original-value");

      const ok = await setSecureKeyAsync("api-key", "new-value");
      expect(ok).toBe(false);

      // Both stores should retain original value — no partial update
      expect(mockBrokerStore.get("api-key")).toBe("original-value");
      expect(getSecureKey("api-key")).toBe("original-value");
    });

    test("deleteSecureKeyAsync failure leaves both stores unchanged", async () => {
      mockBrokerAvailable = true;
      mockBrokerDelError = true;
      mockBrokerStore.set("api-key", "value");
      setSecureKey("api-key", "value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("error");

      // Both stores should retain the key — no partial deletion
      expect(mockBrokerStore.has("api-key")).toBe(true);
      expect(getSecureKey("api-key")).toBe("value");
    });
  });

  // -----------------------------------------------------------------------
  // _setBackend / _resetBackend (no-ops kept for test compat)
  // -----------------------------------------------------------------------
  describe("_setBackend", () => {
    test("_setBackend is a no-op but does not throw", () => {
      _setBackend("encrypted");
      setSecureKey("test", "value");
      expect(existsSync(STORE_PATH)).toBe(true);
    });

    test("_resetBackend is a no-op but does not throw", () => {
      _resetBackend();
      setSecureKey("test", "value");
      expect(getSecureKey("test")).toBe("value");
    });
  });
});
