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

    // Ensure VELLUM_DEV and VELLUM_DESKTOP_APP are NOT set
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
  // CRUD operations (encrypted store backend)
  // -----------------------------------------------------------------------
  describe("CRUD with encrypted backend", () => {
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
  // Desktop app uses encrypted store (same as dev/CLI)
  // -----------------------------------------------------------------------
  describe("desktop app uses encrypted store", () => {
    test("VELLUM_DESKTOP_APP=1 writes to encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBe("new-value");
    });

    test("VELLUM_DESKTOP_APP=1 reads from encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("encrypted-value");
    });

    test("VELLUM_DESKTOP_APP=1 deletes from encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Dev mode — VELLUM_DEV=1 uses encrypted store
  // -----------------------------------------------------------------------
  describe("dev mode (VELLUM_DEV=1)", () => {
    test("setSecureKeyAsync writes to encrypted store", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "dev-value");
      expect(result).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBe("dev-value");
    });

    test("getSecureKeyAsync reads from encrypted store", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("encrypted-value");
    });

    test("getSecureKeyAsync returns undefined when encrypted store is empty", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Non-desktop topology uses encrypted store
  // -----------------------------------------------------------------------
  describe("non-desktop topology", () => {
    test("uses encrypted store", async () => {
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBe("new-value");
    });
  });

  // -----------------------------------------------------------------------
  // Delete — single backend
  // -----------------------------------------------------------------------
  describe("delete from encrypted store", () => {
    test("deleteSecureKeyAsync removes key from encrypted store", async () => {
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync in dev mode deletes from encrypted store", async () => {
      process.env.VELLUM_DEV = "1";
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync returns not-found when key missing", async () => {
      const result = await deleteSecureKeyAsync("missing-key");
      expect(result).toBe("not-found");
    });
  });

  // -----------------------------------------------------------------------
  // listSecureKeysAsync — single-backend key listing
  // -----------------------------------------------------------------------
  describe("listSecureKeysAsync", () => {
    test("returns encrypted store keys", async () => {
      encryptedStore.setKey("enc-key-1", "val1");
      encryptedStore.setKey("enc-key-2", "val2");

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("enc-key-1");
      expect(result.accounts).toContain("enc-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns encrypted store keys with VELLUM_DEV=1", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      encryptedStore.setKey("dev-key-1", "val2");
      encryptedStore.setKey("dev-key-2", "val3");

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("dev-key-1");
      expect(result.accounts).toContain("dev-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns encrypted store keys with VELLUM_DESKTOP_APP=1", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("desktop-key-1", "val1");
      encryptedStore.setKey("desktop-key-2", "val2");

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("desktop-key-1");
      expect(result.accounts).toContain("desktop-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns empty accounts when store is empty", async () => {
      const result = await listSecureKeysAsync();
      expect(result).toEqual({ accounts: [], unreachable: false });
    });
  });

  // -----------------------------------------------------------------------
  // getSecureKeyResultAsync — richer result with unreachable flag
  // -----------------------------------------------------------------------
  describe("getSecureKeyResultAsync", () => {
    test("returns value and unreachable false on success", async () => {
      encryptedStore.setKey("api-key", "stored-value");

      const result = await getSecureKeyResultAsync("api-key");
      expect(result.value).toBe("stored-value");
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false when key missing (encrypted store always reachable)", async () => {
      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false in dev mode", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false with VELLUM_DESKTOP_APP=1", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });
  });
});
