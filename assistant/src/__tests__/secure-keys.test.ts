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

import { _setStorePath } from "../security/encrypted-store.js";
import {
  _resetBackend,
  _setBackend,
  deleteSecureKey,
  getBackendType,
  getSecureKey,
  isDowngradedFromKeychain,
  listSecureKeys,
  setSecureKey,
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
    test("always uses encrypted backend", () => {
      expect(getBackendType()).toBe("encrypted");
    });

    test("isDowngradedFromKeychain always returns false", () => {
      expect(isDowngradedFromKeychain()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // CRUD operations (via encrypted store backend)
  // -----------------------------------------------------------------------
  describe("CRUD with encrypted backend", () => {
    test("set and get a key", () => {
      setSecureKey("openai", "sk-openai-789");
      expect(getSecureKey("openai")).toBe("sk-openai-789");
    });

    test("get returns undefined for nonexistent key", () => {
      expect(getSecureKey("nonexistent")).toBeUndefined();
    });

    test("delete removes a key", () => {
      setSecureKey("gemini", "gem-key");
      expect(deleteSecureKey("gemini")).toBe(true);
      expect(getSecureKey("gemini")).toBeUndefined();
    });

    test("delete returns false for nonexistent key", () => {
      expect(deleteSecureKey("missing")).toBe(false);
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
