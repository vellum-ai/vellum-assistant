/**
 * Tests for resolveSigningKey() covering env var injection (Docker)
 * and file-based load/create (local mode).
 */

import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { resolveSigningKey } = await import("../runtime/auth/token-service.js");
const { getDeprecatedDir } = await import("../util/platform.js");

const VALID_HEX_KEY = "ab".repeat(32); // 64 hex chars = 32 bytes

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.ACTOR_TOKEN_SIGNING_KEY = process.env.ACTOR_TOKEN_SIGNING_KEY;
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
