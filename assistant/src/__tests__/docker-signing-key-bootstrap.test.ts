/**
 * Tests for resolveSigningKey() covering env var injection (Docker),
 * file-based load/create (local mode), and env-to-disk sync for CLI
 * signing-key convergence.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const {
  resolveSigningKey,
  initAuthSigningKey,
  loadSigningKey,
  mintToken,
  verifyToken,
  _resetSigningKeyForTesting,
} = await import("../runtime/auth/token-service.js");
const { CURRENT_POLICY_EPOCH } = await import("../runtime/auth/policy.js");
const { getDeprecatedDir } = await import("../util/platform.js");

const VALID_HEX_KEY = "ab".repeat(32); // 64 hex chars = 32 bytes

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.ACTOR_TOKEN_SIGNING_KEY = process.env.ACTOR_TOKEN_SIGNING_KEY;
  savedEnv.IS_CONTAINERIZED = process.env.IS_CONTAINERIZED;
  // Clean up key files from previous tests so they don't leak between cases.
  const deprecatedDir = getDeprecatedDir();
  if (existsSync(deprecatedDir))
    rmSync(deprecatedDir, { recursive: true, force: true });
});

afterEach(() => {
  if (savedEnv.ACTOR_TOKEN_SIGNING_KEY === undefined) {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;
  } else {
    process.env.ACTOR_TOKEN_SIGNING_KEY = savedEnv.ACTOR_TOKEN_SIGNING_KEY;
  }
  if (savedEnv.IS_CONTAINERIZED === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = savedEnv.IS_CONTAINERIZED;
  }
  // Reset signing key so interop tests don't leak state
  _resetSigningKeyForTesting();
});

describe("resolveSigningKey", () => {
  test("reads key from ACTOR_TOKEN_SIGNING_KEY env var", () => {
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;

    const key = resolveSigningKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(VALID_HEX_KEY);
  });

  test("rejects invalid ACTOR_TOKEN_SIGNING_KEY", () => {
    process.env.ACTOR_TOKEN_SIGNING_KEY = "tooshort";

    expect(() => resolveSigningKey()).toThrow(
      "Invalid ACTOR_TOKEN_SIGNING_KEY",
    );
  });

  test("falls back to disk when env var is not set", () => {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    // resolveSigningKey now falls back to loadOrCreateSigningKey()
    // which will generate a new key under getDeprecatedDir().
    const key = resolveSigningKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  test("different env var values produce different keys", () => {
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;
    const key1 = resolveSigningKey();

    process.env.ACTOR_TOKEN_SIGNING_KEY = "cd".repeat(32);
    const key2 = resolveSigningKey();

    expect(key2.toString("hex")).toBe("cd".repeat(32));
    expect(key2.toString("hex")).not.toBe(key1.toString("hex"));
  });
});

// ---------------------------------------------------------------------------
// Env-to-disk signing key sync
// ---------------------------------------------------------------------------

describe("env-to-disk signing key sync", () => {
  test("env key syncs to canonical disk path in non-containerized mode", () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;

    const key = resolveSigningKey();

    expect(key.toString("hex")).toBe(VALID_HEX_KEY);

    const keyPath = join(getDeprecatedDir(), "actor-token-signing-key");
    expect(existsSync(keyPath)).toBe(true);
    const diskKey = readFileSync(keyPath);
    expect(diskKey.length).toBe(32);
    expect(diskKey.toString("hex")).toBe(VALID_HEX_KEY);
  });

  test("env key does NOT sync to disk in containerized mode", () => {
    process.env.IS_CONTAINERIZED = "true";
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;

    const key = resolveSigningKey();

    expect(key.toString("hex")).toBe(VALID_HEX_KEY);

    const keyPath = join(getDeprecatedDir(), "actor-token-signing-key");
    expect(existsSync(keyPath)).toBe(false);
  });

  test("mismatched disk key is updated to env key in non-containerized mode", () => {
    delete process.env.IS_CONTAINERIZED;

    // Write a mismatched key to disk first
    const keyPath = join(getDeprecatedDir(), "actor-token-signing-key");
    const dir = dirname(keyPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const mismatchedKey = Buffer.from("ff".repeat(32), "hex");
    writeFileSync(keyPath, mismatchedKey, { mode: 0o600 });

    // Set a different env key
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;

    const key = resolveSigningKey();
    expect(key.toString("hex")).toBe(VALID_HEX_KEY);

    // Disk key should now match env key
    const diskKey = readFileSync(keyPath);
    expect(diskKey.toString("hex")).toBe(VALID_HEX_KEY);
  });

  test("matching disk key is not rewritten (no-op)", () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;

    // First call writes the key
    resolveSigningKey();
    const keyPath = join(getDeprecatedDir(), "actor-token-signing-key");
    expect(existsSync(keyPath)).toBe(true);

    // Second call with same key should not throw or fail
    const key2 = resolveSigningKey();
    expect(key2.toString("hex")).toBe(VALID_HEX_KEY);

    const diskKey = readFileSync(keyPath);
    expect(diskKey.toString("hex")).toBe(VALID_HEX_KEY);
  });
});

// ---------------------------------------------------------------------------
// Signature interoperability between daemon (env key) and CLI (disk key)
// ---------------------------------------------------------------------------

describe("daemon/CLI signing key interoperability", () => {
  test("token minted via CLI disk-load path verifies with daemon env key after sync", () => {
    delete process.env.IS_CONTAINERIZED;

    // Pre-seed a mismatched "legacy" disk key to simulate the pre-fix state
    const keyPath = join(getDeprecatedDir(), "actor-token-signing-key");
    const dir = dirname(keyPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const legacyKey = Buffer.from("ee".repeat(32), "hex");
    writeFileSync(keyPath, legacyKey, { mode: 0o600 });

    // --- Daemon startup path ---
    // Set the env key and call resolveSigningKey (daemon behavior).
    // This syncs the env key to disk.
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;
    const daemonKey = resolveSigningKey();
    initAuthSigningKey(daemonKey);

    // Mint a token using the daemon's key
    const daemonToken = mintToken({
      aud: "vellum-daemon",
      sub: "svc:daemon:self",
      scope_profile: "gateway_service_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });

    // --- CLI subprocess path ---
    // Reset signing key to simulate a fresh CLI subprocess context
    _resetSigningKeyForTesting();

    // CLI loads key from disk (post-sync, disk now matches env key)
    const cliDiskKey = loadSigningKey();
    expect(cliDiskKey).toBeDefined();
    initAuthSigningKey(cliDiskKey!);

    // Mint a token using the CLI's disk-loaded key
    const cliToken = mintToken({
      aud: "vellum-daemon",
      sub: "svc:daemon:self",
      scope_profile: "gateway_service_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });

    // --- Cross-verification ---
    // CLI-minted token must verify with daemon key
    _resetSigningKeyForTesting();
    initAuthSigningKey(daemonKey);
    const cliResult = verifyToken(cliToken, "vellum-daemon");
    expect(cliResult.ok).toBe(true);

    // Daemon-minted token must verify with CLI disk key
    _resetSigningKeyForTesting();
    initAuthSigningKey(cliDiskKey!);
    const daemonResult = verifyToken(daemonToken, "vellum-daemon");
    expect(daemonResult.ok).toBe(true);
  });
});
