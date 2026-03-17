import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
// Mock only the logger (not platform -- we use _setStorePath instead)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  _setStoreKeyPath,
  _setStorePath,
  deleteKey,
  getKey,
  getMachineEntropy,
  listKeys,
  setKey,
} from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Use a temp directory so tests don't touch the real ~/.vellum
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-enc-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");
const STORE_KEY_PATH = join(TEST_DIR, "store.key");

// ---------------------------------------------------------------------------
// Legacy v1 helpers (for migration tests)
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = process.env.BUN_TEST === "1" ? 1 : 100_000;
const SALT_LENGTH = 32;

function legacyDeriveKey(salt: Buffer): Buffer {
  const entropy = getMachineEntropy();
  return pbkdf2Sync(entropy, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
}

function legacyEncrypt(
  plaintext: string,
  key: Buffer,
): { iv: string; tag: string; data: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

/** Write a v1 store file directly (bypassing the module's writeStore). */
function writeV1Store(
  path: string,
  salt: Buffer,
  entries: Record<string, { iv: string; tag: string; data: string }>,
): void {
  const store = {
    version: 1,
    salt: salt.toString("hex"),
    entries,
  };
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("encrypted-store", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    // Clear content files but preserve the directory structure
    for (const entry of readdirSync(TEST_DIR)) {
      rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
    }
    _setStorePath(STORE_PATH);
    _setStoreKeyPath(STORE_KEY_PATH);
  });

  afterEach(() => {
    _setStorePath(null);
    _setStoreKeyPath(null);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Basic CRUD
  // -----------------------------------------------------------------------
  describe("basic operations", () => {
    test("setKey creates the store file and returns true", () => {
      const result = setKey("anthropic", "sk-ant-key123");
      expect(result).toBe(true);
      expect(existsSync(STORE_PATH)).toBe(true);
    });

    test("getKey retrieves a previously stored value", () => {
      setKey("anthropic", "sk-ant-key123");
      const result = getKey("anthropic");
      expect(result).toBe("sk-ant-key123");
    });

    test("getKey returns undefined for nonexistent key", () => {
      expect(getKey("nonexistent")).toBeUndefined();
    });

    test("getKey returns undefined when store file does not exist", () => {
      expect(getKey("anything")).toBeUndefined();
    });

    test("setKey overwrites existing value", () => {
      setKey("anthropic", "old-value");
      setKey("anthropic", "new-value");
      expect(getKey("anthropic")).toBe("new-value");
    });

    test("deleteKey removes an entry and returns deleted", () => {
      setKey("anthropic", "sk-ant-key123");
      const result = deleteKey("anthropic");
      expect(result).toBe("deleted");
      expect(getKey("anthropic")).toBeUndefined();
    });

    test("deleteKey returns not-found for nonexistent key", () => {
      setKey("anthropic", "value");
      expect(deleteKey("nonexistent")).toBe("not-found");
    });

    test("deleteKey returns not-found when store does not exist", () => {
      expect(deleteKey("anything")).toBe("not-found");
    });
  });

  // -----------------------------------------------------------------------
  // Multiple keys
  // -----------------------------------------------------------------------
  describe("multiple keys", () => {
    test("stores and retrieves multiple independent keys", () => {
      setKey("anthropic", "sk-ant-123");
      setKey("openai", "sk-openai-456");
      setKey("gemini", "gem-key-789");

      expect(getKey("anthropic")).toBe("sk-ant-123");
      expect(getKey("openai")).toBe("sk-openai-456");
      expect(getKey("gemini")).toBe("gem-key-789");
    });

    test("deleting one key does not affect others", () => {
      setKey("anthropic", "val-1");
      setKey("openai", "val-2");
      deleteKey("anthropic");

      expect(getKey("anthropic")).toBeUndefined();
      expect(getKey("openai")).toBe("val-2");
    });
  });

  // -----------------------------------------------------------------------
  // listKeys
  // -----------------------------------------------------------------------
  describe("listKeys", () => {
    test("returns empty array when store does not exist", () => {
      expect(listKeys()).toEqual([]);
    });

    test("returns all stored account names", () => {
      setKey("anthropic", "val-1");
      setKey("openai", "val-2");
      const keys = listKeys();
      expect(keys).toContain("anthropic");
      expect(keys).toContain("openai");
      expect(keys.length).toBe(2);
    });

    test("reflects deletions", () => {
      setKey("anthropic", "val-1");
      setKey("openai", "val-2");
      deleteKey("anthropic");
      expect(listKeys()).toEqual(["openai"]);
    });
  });

  // -----------------------------------------------------------------------
  // Store format (v2)
  // -----------------------------------------------------------------------
  describe("store format", () => {
    test("store file is valid JSON with version 2 and entries (no salt)", () => {
      setKey("test", "value");
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(2);
      expect(parsed.salt).toBeUndefined();
      expect(typeof parsed.entries).toBe("object");
      expect(parsed.entries.test).toBeDefined();
    });

    test("each entry has iv, tag, and data fields", () => {
      setKey("test", "value");
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      const entry = parsed.entries.test;
      expect(typeof entry.iv).toBe("string");
      expect(entry.iv.length).toBe(32); // 16 bytes = 32 hex chars
      expect(typeof entry.tag).toBe("string");
      expect(entry.tag.length).toBe(32); // 16 bytes = 32 hex chars
      expect(typeof entry.data).toBe("string");
      expect(entry.data.length).toBeGreaterThan(0);
    });

    test("ciphertext does not contain the plaintext value", () => {
      const secret = "super-secret-api-key-12345";
      setKey("test", secret);
      const raw = readFileSync(STORE_PATH, "utf-8");
      expect(raw).not.toContain(secret);
    });

    test("different values produce different ciphertexts (unique IVs)", () => {
      setKey("key1", "same-value");
      const raw1 = readFileSync(STORE_PATH, "utf-8");
      const entry1 = JSON.parse(raw1).entries.key1;

      // Delete and re-set to get a new IV
      deleteKey("key1");
      setKey("key1", "same-value");
      const raw2 = readFileSync(STORE_PATH, "utf-8");
      const entry2 = JSON.parse(raw2).entries.key1;

      // IVs should differ (random), so ciphertext should differ too
      expect(entry1.iv).not.toBe(entry2.iv);
    });
  });

  // -----------------------------------------------------------------------
  // v2 format and store.key
  // -----------------------------------------------------------------------
  describe("v2 format and store.key", () => {
    test("fresh store creates v2 format and store.key", () => {
      setKey("test", "value");

      // Verify keys.enc is v2 with no salt
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(2);
      expect(parsed.salt).toBeUndefined();

      // Verify store.key exists with exactly 32 bytes and 0o600 perms
      expect(existsSync(STORE_KEY_PATH)).toBe(true);
      const keyBuf = readFileSync(STORE_KEY_PATH);
      expect(keyBuf.length).toBe(32);
      const mode = statSync(STORE_KEY_PATH).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    test("v2 round-trip", () => {
      // Set multiple values and read them back
      setKey("key-a", "value-a");
      setKey("key-b", "value-b");
      setKey("key-c", "value-c");

      expect(getKey("key-a")).toBe("value-a");
      expect(getKey("key-b")).toBe("value-b");
      expect(getKey("key-c")).toBe("value-c");

      // Delete one and verify others remain
      deleteKey("key-b");
      expect(getKey("key-b")).toBeUndefined();
      expect(getKey("key-a")).toBe("value-a");
      expect(getKey("key-c")).toBe("value-c");
    });

    test("v2 store without store.key returns undefined", () => {
      setKey("test", "value");
      // Delete store.key
      unlinkSync(STORE_KEY_PATH);
      expect(getKey("test")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // v1 -> v2 migration
  // -----------------------------------------------------------------------
  describe("v1 to v2 migration", () => {
    test("v1 to v2 migration preserves entries", () => {
      // Create a v1 store using legacy encryption
      const salt = randomBytes(SALT_LENGTH);
      const legacyKey = legacyDeriveKey(salt);
      const entries: Record<string, { iv: string; tag: string; data: string }> = {};
      entries["api-key"] = legacyEncrypt("secret-123", legacyKey);
      entries["other-key"] = legacyEncrypt("secret-456", legacyKey);
      writeV1Store(STORE_PATH, salt, entries);

      // Access via getKey -- should trigger migration
      const val1 = getKey("api-key");
      expect(val1).toBe("secret-123");

      const val2 = getKey("other-key");
      expect(val2).toBe("secret-456");

      // Store should now be v2
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(2);
      expect(parsed.salt).toBeUndefined();

      // store.key should exist
      expect(existsSync(STORE_KEY_PATH)).toBe(true);
    });

    test("migration is idempotent", () => {
      // Create a v1 store
      const salt = randomBytes(SALT_LENGTH);
      const legacyKey = legacyDeriveKey(salt);
      const entries: Record<string, { iv: string; tag: string; data: string }> = {};
      entries["my-key"] = legacyEncrypt("my-value", legacyKey);
      writeV1Store(STORE_PATH, salt, entries);

      // First access triggers migration
      const val1 = getKey("my-key");
      expect(val1).toBe("my-value");

      // Second access should work the same (already migrated)
      const val2 = getKey("my-key");
      expect(val2).toBe("my-value");

      // Should still be v2
      const raw = readFileSync(STORE_PATH, "utf-8");
      expect(JSON.parse(raw).version).toBe(2);
    });

    test("migration skips corrupt entries", () => {
      // Create a v1 store with one good entry and one tampered entry
      const salt = randomBytes(SALT_LENGTH);
      const legacyKey = legacyDeriveKey(salt);
      const entries: Record<string, { iv: string; tag: string; data: string }> = {};
      entries["good"] = legacyEncrypt("good-value", legacyKey);
      entries["bad"] = legacyEncrypt("bad-value", legacyKey);
      // Tamper with the bad entry
      const badData = entries["bad"].data;
      entries["bad"].data =
        badData[0] === "0" ? "1" + badData.slice(1) : "0" + badData.slice(1);
      writeV1Store(STORE_PATH, salt, entries);

      // Trigger migration via getKey
      const goodVal = getKey("good");
      expect(goodVal).toBe("good-value");

      // Bad entry should be gone (not migrated)
      const badVal = getKey("bad");
      expect(badVal).toBeUndefined();

      // Store should be v2
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(2);
      expect(parsed.entries["good"]).toBeDefined();
      expect(parsed.entries["bad"]).toBeUndefined();
    });

    test("partial migration recovery", () => {
      // Simulate crash between store.key write and store rewrite:
      // write v1 store + store.key but leave store as v1
      const salt = randomBytes(SALT_LENGTH);
      const legacyKey = legacyDeriveKey(salt);
      const entries: Record<string, { iv: string; tag: string; data: string }> = {};
      entries["test-key"] = legacyEncrypt("test-value", legacyKey);
      writeV1Store(STORE_PATH, salt, entries);

      // Pre-write store.key (simulating partial migration)
      const preKey = randomBytes(32);
      writeFileSync(STORE_KEY_PATH, preKey, { mode: 0o600 });

      // Migration should complete using the existing store.key
      const val = getKey("test-key");
      expect(val).toBe("test-value");

      // Verify the store.key was reused (not regenerated)
      const afterKey = readFileSync(STORE_KEY_PATH);
      expect(afterKey.equals(preKey)).toBe(true);

      // Store should now be v2
      const raw = readFileSync(STORE_PATH, "utf-8");
      expect(JSON.parse(raw).version).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    test("getKey returns undefined for corrupted store file", () => {
      writeFileSync(STORE_PATH, "not valid json");
      expect(getKey("test")).toBeUndefined();
    });

    test("getKey returns undefined for invalid store version", () => {
      writeFileSync(
        STORE_PATH,
        JSON.stringify({
          version: 99,
          salt: "abc",
          entries: {},
        }),
      );
      expect(getKey("test")).toBeUndefined();
    });

    test("getKey returns undefined when entry has tampered ciphertext", () => {
      setKey("test", "secret");
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      // Flip a byte in the ciphertext
      const data = parsed.entries.test.data;
      const flipped =
        data[0] === "0" ? "1" + data.slice(1) : "0" + data.slice(1);
      parsed.entries.test.data = flipped;
      writeFileSync(STORE_PATH, JSON.stringify(parsed));
      // GCM auth should fail
      expect(getKey("test")).toBeUndefined();
    });

    test("getKey returns undefined when auth tag is tampered", () => {
      setKey("test", "secret");
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      // Flip a byte in the auth tag
      const tag = parsed.entries.test.tag;
      const flipped = tag[0] === "0" ? "1" + tag.slice(1) : "0" + tag.slice(1);
      parsed.entries.test.tag = flipped;
      writeFileSync(STORE_PATH, JSON.stringify(parsed));
      expect(getKey("test")).toBeUndefined();
    });

    test("setKey creates directory if missing", () => {
      // Point to a path in a non-existent subdirectory
      const nestedPath = join(TEST_DIR, "sub", "dir", "keys.enc");
      const nestedKeyPath = join(TEST_DIR, "sub", "dir", "store.key");
      _setStorePath(nestedPath);
      _setStoreKeyPath(nestedKeyPath);
      const result = setKey("test", "value");
      expect(result).toBe(true);
      expect(getKey("test")).toBe("value");
    });

    test("setKey recovers from a corrupt store file by backing up and creating fresh store", () => {
      // Write a valid store first
      setKey("existing", "old-secret");
      // Corrupt the store
      writeFileSync(STORE_PATH, "corrupted data");
      // setKey should recover by backing up corrupt file and creating fresh store
      const result = setKey("new-key", "new-value");
      expect(result).toBe(true);
      // Old key is lost but new key works
      expect(getKey("new-key")).toBe("new-value");
      expect(getKey("existing")).toBeUndefined();
    });

    test("setKey recovers from a store with invalid version", () => {
      writeFileSync(
        STORE_PATH,
        JSON.stringify({
          version: 99,
          salt: "abc",
          entries: {},
        }),
      );
      // setKey should recover by backing up invalid store and creating fresh store
      const result = setKey("test", "value");
      expect(result).toBe(true);
      expect(getKey("test")).toBe("value");
    });

    test("writeStore enforces 0600 permissions on existing files", () => {
      setKey("test", "value");
      // Loosen permissions
      chmodSync(STORE_PATH, 0o644);
      // Write again -- should re-enforce 0600
      setKey("test2", "value2");
      const mode = statSync(STORE_PATH).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    test("handles empty string value", () => {
      setKey("empty", "");
      expect(getKey("empty")).toBe("");
    });

    test("handles very long values", () => {
      const longValue = "x".repeat(10_000);
      setKey("long", longValue);
      expect(getKey("long")).toBe(longValue);
    });

    test("handles special characters in value", () => {
      const special = '🔑 key=val&foo "bar" \n\t\\';
      setKey("special", special);
      expect(getKey("special")).toBe(special);
    });

    test("handles special characters in account name", () => {
      setKey("my/nested.key", "value");
      expect(getKey("my/nested.key")).toBe("value");
    });

    test("__proto__ account name works correctly", () => {
      setKey("__proto__", "proto-value");
      expect(getKey("__proto__")).toBe("proto-value");
      expect(listKeys()).toContain("__proto__");
      deleteKey("__proto__");
      expect(getKey("__proto__")).toBeUndefined();
    });

    test("store.key is reused across set operations", () => {
      setKey("key1", "val1");
      const key1 = readFileSync(STORE_KEY_PATH);

      setKey("key2", "val2");
      const key2 = readFileSync(STORE_KEY_PATH);

      expect(key1.equals(key2)).toBe(true);
    });
  });
});
