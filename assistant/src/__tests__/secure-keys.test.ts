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
let mockBrokerSetCalled = false;

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
      mockBrokerSetCalled = true;
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

import * as encryptedStore from "../security/encrypted-store.js";
import { _setStorePath } from "../security/encrypted-store.js";
import {
  _resetBackend,
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
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
    mockBrokerSetCalled = false;

    // Ensure VELLUM_DEV and VELLUM_DESKTOP_APP are NOT set so broker tests work by default
    delete process.env.VELLUM_DEV;
    delete process.env.VELLUM_DESKTOP_APP;

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
  });

  afterEach(() => {
    _setStorePath(null);
    _resetBackend();
    delete process.env.VELLUM_DEV;
    delete process.env.VELLUM_DESKTOP_APP;
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -----------------------------------------------------------------------
  // CRUD operations (via encrypted store backend — broker unavailable)
  // -----------------------------------------------------------------------
  describe("CRUD with encrypted backend (broker unavailable)", () => {
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
  });

  // -----------------------------------------------------------------------
  // Single-writer: writes go to keychain only when broker available
  // -----------------------------------------------------------------------
  describe("single-writer with broker available", () => {
    test("setSecureKeyAsync writes to broker only (not encrypted store)", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      // Value is in the broker store
      expect(mockBrokerStore.get("api-key")).toBe("new-value");
      // Value should NOT be in the encrypted store (single-writer)
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("setSecureKeyAsync returns false on broker set error", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      mockBrokerSetError = true;
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(false);
      expect(mockBrokerStore.has("api-key")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Reads: primary backend only, no fallback
  // -----------------------------------------------------------------------
  describe("reads with broker available", () => {
    test("getSecureKeyAsync reads from broker (primary backend)", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");
      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("broker-value");
      expect(mockBrokerGetCalled).toBe(true);
    });

    test("getSecureKeyAsync does not fall back to encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      // Pre-populate encrypted store directly (legacy key not in broker)
      encryptedStore.setKey("legacy-key", "legacy-value");

      const result = await getSecureKeyAsync("legacy-key");
      expect(result).toBeUndefined();
      // Broker was checked (returned nothing), no fallback to encrypted store
      expect(mockBrokerGetCalled).toBe(true);
    });

    test("getSecureKeyAsync returns undefined when neither store has the key", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      expect(await getSecureKeyAsync("missing-key")).toBeUndefined();
    });

    test("getSecureKeyAsync returns broker value even when encrypted store also has a value", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      // Both stores have a value — broker (primary) should win
      mockBrokerStore.set("api-key", "broker-value");
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("broker-value");
    });
  });

  // -----------------------------------------------------------------------
  // Dev mode bypass — VELLUM_DEV=1 uses encrypted store only
  // -----------------------------------------------------------------------
  describe("dev mode bypass (VELLUM_DEV=1)", () => {
    test("setSecureKeyAsync writes to encrypted store only, ignoring broker", async () => {
      process.env.VELLUM_DEV = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "dev-value");
      expect(result).toBe(true);
      // Written to encrypted store
      expect(encryptedStore.getKey("api-key")).toBe("dev-value");
      // NOT written to broker
      expect(mockBrokerStore.has("api-key")).toBe(false);
      expect(mockBrokerSetCalled).toBe(false);
    });

    test("getSecureKeyAsync reads from encrypted store only, ignoring broker", async () => {
      process.env.VELLUM_DEV = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("encrypted-value");
      // Broker should not have been contacted
      expect(mockBrokerGetCalled).toBe(false);
    });

    test("getSecureKeyAsync returns undefined when encrypted store is empty (does not check broker)", async () => {
      process.env.VELLUM_DEV = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBeUndefined();
      expect(mockBrokerGetCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // VELLUM_DESKTOP_APP gating — keychain backend selection
  // -----------------------------------------------------------------------
  describe("VELLUM_DESKTOP_APP gating", () => {
    test("uses keychain when VELLUM_DESKTOP_APP=1 and broker available", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      // Value is in the broker store (keychain backend)
      expect(mockBrokerStore.get("api-key")).toBe("new-value");
      // Value should NOT be in the encrypted store
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test(
      "still resolves to keychain when VELLUM_DESKTOP_APP=1 and broker unavailable",
      async () => {
        process.env.VELLUM_DESKTOP_APP = "1";
        mockBrokerAvailable = false;
        mockBrokerGetError = true;
        _resetBackend();

        // Backend resolves to keychain even though broker is unavailable.
        // Operations will report unreachable rather than falling back to encrypted store.
        const result = await getSecureKeyResultAsync("api-key");
        expect(result.value).toBeUndefined();
        expect(result.unreachable).toBe(true);
      },
      { timeout: 10_000 },
    );

    test("non-desktop topology uses encrypted store even when broker is available", async () => {
      // VELLUM_DESKTOP_APP is NOT set
      mockBrokerAvailable = true;
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      // Value is in the encrypted store (not broker)
      expect(encryptedStore.getKey("api-key")).toBe("new-value");
      // Broker should NOT have been used
      expect(mockBrokerSetCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Delete — single backend only
  // -----------------------------------------------------------------------
  describe("delete from single backend", () => {
    test("deleteSecureKeyAsync removes from broker store only when broker available", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(mockBrokerStore.has("api-key")).toBe(false);
    });

    test("deleteSecureKeyAsync returns deleted when only encrypted store has key", async () => {
      // Broker unavailable — only encrypted store
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync returns error when broker delete fails", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      mockBrokerDelError = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("error");
    });

    test("deleteSecureKeyAsync in dev mode deletes from encrypted store only", async () => {
      process.env.VELLUM_DEV = "1";
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      // Dev mode resolves to encrypted store — broker should NOT be touched
      expect(mockBrokerStore.has("api-key")).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync returns not-found when key missing from both stores", async () => {
      // Broker unavailable, encrypted store empty
      const result = await deleteSecureKeyAsync("missing-key");
      expect(result).toBe("not-found");
    });
  });

  // -----------------------------------------------------------------------
  // Legacy read fallback
  // -----------------------------------------------------------------------
  describe("legacy read fallback", () => {
    test("does not fall back to encrypted store for legacy keys", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      // Simulate a legacy key that was written to encrypted store before
      // the single-writer migration — broker doesn't have it.
      encryptedStore.setKey("legacy-account", "legacy-secret");

      const result = await getSecureKeyAsync("legacy-account");
      expect(result).toBeUndefined();
    });

    test("does not fall back to encrypted store when already using encrypted store backend", async () => {
      // Broker unavailable — primary backend IS the encrypted store.
      // No fallback needed.
      encryptedStore.setKey("account", "value");
      encryptedStore.setKey("other-account", "other-value");

      // Should read directly from encrypted store (primary)
      const result = await getSecureKeyAsync("account");
      expect(result).toBe("value");
      // Broker should not have been contacted
      expect(mockBrokerGetCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Stale-value prevention
  // -----------------------------------------------------------------------
  describe("stale-value prevention", () => {
    test("setSecureKeyAsync failure does not corrupt broker store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      // Pre-seed broker with original value
      mockBrokerStore.set("api-key", "original-value");

      // Now fail the next set
      mockBrokerSetError = true;
      const ok = await setSecureKeyAsync("api-key", "new-value");
      expect(ok).toBe(false);

      // Broker should still have original value
      expect(mockBrokerStore.get("api-key")).toBe("original-value");
    });
  });

  // -----------------------------------------------------------------------
  // listSecureKeysAsync — single-backend key listing
  // -----------------------------------------------------------------------
  describe("listSecureKeysAsync", () => {
    test("returns only broker keys when broker is primary (no encrypted store merge)", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      // Broker has some keys
      mockBrokerStore.set("broker-key-1", "val1");
      mockBrokerStore.set("shared-key", "broker-val");

      // Encrypted store has legacy keys — should NOT be included
      encryptedStore.setKey("legacy-key-1", "val2");
      encryptedStore.setKey("shared-key", "enc-val");

      const keys = await listSecureKeysAsync();
      expect(keys).toContain("broker-key-1");
      expect(keys).toContain("shared-key");
      expect(keys).not.toContain("legacy-key-1");
      // Should be exactly 2 keys (broker only)
      expect(keys.length).toBe(2);
    });

    test("returns only encrypted store keys when broker is unavailable", async () => {
      // Broker unavailable (default state) — primary backend is encrypted store
      encryptedStore.setKey("enc-key-1", "val1");
      encryptedStore.setKey("enc-key-2", "val2");

      const keys = await listSecureKeysAsync();
      expect(keys).toContain("enc-key-1");
      expect(keys).toContain("enc-key-2");
      expect(keys.length).toBe(2);
    });

    test("returns only encrypted store keys when VELLUM_DEV=1 (even if broker available)", async () => {
      process.env.VELLUM_DEV = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      // Broker has keys that should be ignored
      mockBrokerStore.set("broker-only", "val1");

      // Encrypted store has keys
      encryptedStore.setKey("dev-key-1", "val2");
      encryptedStore.setKey("dev-key-2", "val3");

      const keys = await listSecureKeysAsync();
      expect(keys).toContain("dev-key-1");
      expect(keys).toContain("dev-key-2");
      // broker-only key should NOT appear since primary backend is encrypted store
      expect(keys).not.toContain("broker-only");
      expect(keys.length).toBe(2);
    });

    test("returns broker-only keys when encrypted store is empty", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("broker-key-1", "val1");
      mockBrokerStore.set("broker-key-2", "val2");

      const keys = await listSecureKeysAsync();
      expect(keys).toContain("broker-key-1");
      expect(keys).toContain("broker-key-2");
      expect(keys.length).toBe(2);
    });

    test("returns empty array when both stores are empty", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      const keys = await listSecureKeysAsync();
      expect(keys).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getSecureKeyResultAsync — richer result with unreachable flag
  // -----------------------------------------------------------------------
  describe("getSecureKeyResultAsync", () => {
    test("returns unreachable true when broker errors", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      mockBrokerGetError = true;
      _resetBackend();

      const result = await getSecureKeyResultAsync("api-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(true);
    });

    test("returns value and unreachable false on success", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      _resetBackend();

      mockBrokerStore.set("api-key", "broker-value");
      const result = await getSecureKeyResultAsync("api-key");
      expect(result.value).toBe("broker-value");
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable when broker errors, does not fall back", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      mockBrokerGetError = true;
      _resetBackend();

      encryptedStore.setKey("legacy-key", "legacy-value");
      const result = await getSecureKeyResultAsync("legacy-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(true);
    });

    test("propagates unreachable when broker errors and encrypted store also missing", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      mockBrokerAvailable = true;
      mockBrokerGetError = true;
      _resetBackend();

      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(true);
    });

    test("returns unreachable false in dev mode (encrypted store backend)", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });
  });
});
