/**
 * Filesystem-level tests for the CES local SecureKeyBackend.
 *
 * These tests exercise `createLocalSecureKeyBackend` with real files and
 * env-var overrides, separate from the in-memory resolver/materialiser
 * tests in `local-materializers.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createLocalSecureKeyBackend,
  StoreUnavailableError,
} from "../materializers/local-secure-key-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ces-backend-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLocalSecureKeyBackend — filesystem", () => {
  let tmpDir: string | undefined;
  let savedSecurityDir: string | undefined;

  afterEach(() => {
    if (savedSecurityDir !== undefined) {
      process.env.CREDENTIAL_SECURITY_DIR = savedSecurityDir;
    } else {
      delete process.env.CREDENTIAL_SECURITY_DIR;
    }
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
    savedSecurityDir = undefined;
  });

  function setup(): { securityDir: string; vellumRoot: string } {
    tmpDir = makeTmpDir();
    const securityDir = join(tmpDir, "security");
    mkdirSync(securityDir, { recursive: true });
    savedSecurityDir = process.env.CREDENTIAL_SECURITY_DIR;
    process.env.CREDENTIAL_SECURITY_DIR = securityDir;
    // vellumRoot is unused when CREDENTIAL_SECURITY_DIR is set,
    // but we pass tmpDir for consistency
    return { securityDir, vellumRoot: tmpDir };
  }

  test("set() on a fresh security directory creates store.key and keys.enc", async () => {
    const { securityDir, vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);

    const result = await backend.set("test/key", "secret-value");
    expect(result).toBe(true);

    // store.key exists, is 32 bytes, mode 0o600
    const keyPath = join(securityDir, "store.key");
    expect(existsSync(keyPath)).toBe(true);
    const keyBuf = readFileSync(keyPath);
    expect(keyBuf.length).toBe(32);
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);

    // keys.enc exists and is valid v2 JSON
    const encPath = join(securityDir, "keys.enc");
    expect(existsSync(encPath)).toBe(true);
    const store = JSON.parse(readFileSync(encPath, "utf-8"));
    expect(store.version).toBe(2);
    expect(typeof store.entries).toBe("object");

    // Round-trip
    const value = await backend.get("test/key");
    expect(value).toBe("secret-value");
  });

  test("subsequent set() calls append to the existing store without recreating files", async () => {
    const { securityDir, vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);

    await backend.set("key1", "val1");
    const keyAfterFirst = readFileSync(join(securityDir, "store.key"));

    await backend.set("key2", "val2");
    const keyAfterSecond = readFileSync(join(securityDir, "store.key"));

    // store.key was not regenerated
    expect(Buffer.compare(keyAfterFirst, keyAfterSecond)).toBe(0);

    // keys.enc has exactly 2 entries
    const store = JSON.parse(readFileSync(join(securityDir, "keys.enc"), "utf-8"));
    expect(Object.keys(store.entries).length).toBe(2);

    // Both values round-trip
    expect(await backend.get("key1")).toBe("val1");
    expect(await backend.get("key2")).toBe("val2");
  });

  test("set() against a pre-existing v1 store preserves format and round-trips", async () => {
    const { securityDir, vellumRoot } = setup();

    // Manually write a v1 store
    const salt = randomBytes(32).toString("hex");
    const v1Store = { version: 1, salt, entries: {} };
    writeFileSync(join(securityDir, "keys.enc"), JSON.stringify(v1Store, null, 2), {
      mode: 0o600,
    });

    const backend = createLocalSecureKeyBackend(vellumRoot);
    const result = await backend.set("v1-key", "v1-value");
    expect(result).toBe(true);

    // Read back and verify format preserved
    const storeAfter = JSON.parse(readFileSync(join(securityDir, "keys.enc"), "utf-8"));
    expect(storeAfter.version).toBe(1);
    expect(storeAfter.salt).toBe(salt);
    expect(Object.keys(storeAfter.entries)).toContain("v1-key");

    // store.key was NOT created (v1 stores don't use it)
    expect(existsSync(join(securityDir, "store.key"))).toBe(false);

    // Round-trip
    const value = await backend.get("v1-key");
    expect(value).toBe("v1-value");
  });

  test("get() returns undefined when no store exists", async () => {
    const { vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);
    const value = await backend.get("anything");
    expect(value).toBeUndefined();
  });

  test("list() returns empty array when no store exists", async () => {
    const { vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);
    const keys = await backend.list();
    expect(keys).toEqual([]);
  });

  test("delete() returns error when no store exists", async () => {
    const { vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);
    const result = await backend.delete("anything");
    expect(result).toBe("error");
  });

  // -------------------------------------------------------------------------
  // UNAVAILABLE (store exists but cannot be read / decrypted) must be distinct
  // from ABSENT (no store, or the store reads cleanly but lacks the key). The
  // former throws so the RPC layer reports `unreachable`; the latter returns
  // undefined/[]. This is the cold-start fix: a transiently-unreadable store or
  // missing key material must never masquerade as "credential not found".
  // -------------------------------------------------------------------------

  test("get() THROWS (not undefined) when the store file exists but is unreadable", async () => {
    const { securityDir, vellumRoot } = setup();
    // A store file that exists but cannot be parsed (e.g. a partial/corrupt
    // read) — distinct from no store at all.
    writeFileSync(join(securityDir, "keys.enc"), "{ not valid json", {
      mode: 0o600,
    });
    const backend = createLocalSecureKeyBackend(vellumRoot);
    await expect(backend.get("anything")).rejects.toThrow(StoreUnavailableError);
  });

  test("get() returns undefined when the store reads cleanly but the key is absent", async () => {
    const { vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);
    await backend.set("present/key", "v"); // valid store with one entry
    // A genuinely missing key in a readable store is ABSENT, not unavailable.
    expect(await backend.get("absent/key")).toBeUndefined();
  });

  test("get() THROWS when a v2 entry exists but store.key is missing (cold-start key-material race)", async () => {
    const { securityDir, vellumRoot } = setup();
    const backend = createLocalSecureKeyBackend(vellumRoot);
    await backend.set("k", "v"); // creates the v2 store + store.key
    expect(await backend.get("k")).toBe("v"); // sanity: warm read works
    // Simulate the cold-start window where the key material is transiently
    // unavailable: the entry still exists, but it cannot be decrypted yet.
    rmSync(join(securityDir, "store.key"));
    await expect(backend.get("k")).rejects.toThrow(StoreUnavailableError);
  });

  test("list() THROWS (not []) when the store file exists but is unreadable", async () => {
    const { securityDir, vellumRoot } = setup();
    writeFileSync(join(securityDir, "keys.enc"), "{ corrupt", { mode: 0o600 });
    const backend = createLocalSecureKeyBackend(vellumRoot);
    await expect(backend.list()).rejects.toThrow(StoreUnavailableError);
  });
});
