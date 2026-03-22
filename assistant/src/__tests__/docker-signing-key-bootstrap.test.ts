/**
 * Tests for resolveSigningKey() covering env var injection (Docker)
 * and file-based load/create (local mode).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "signing-key-test-")));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getDbPath: () => join(testDir, "test.db"),
  normalizeAssistantId: (id: string) => (id === "self" ? "self" : id),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { resolveSigningKey } = await import("../runtime/auth/token-service.js");

const VALID_HEX_KEY = "ab".repeat(32); // 64 hex chars = 32 bytes

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.ACTOR_TOKEN_SIGNING_KEY = process.env.ACTOR_TOKEN_SIGNING_KEY;
  mkdirSync(join(testDir, "protected"), { recursive: true });
});

afterEach(() => {
  if (savedEnv.ACTOR_TOKEN_SIGNING_KEY === undefined) {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;
  } else {
    process.env.ACTOR_TOKEN_SIGNING_KEY = savedEnv.ACTOR_TOKEN_SIGNING_KEY;
  }
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
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

    expect(() => resolveSigningKey()).toThrow("Invalid ACTOR_TOKEN_SIGNING_KEY");
  });

  test("falls back to file-based load/create when env var is not set", () => {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    const key = resolveSigningKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  test("env var takes priority over file on disk", () => {
    process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;

    // First call creates a file-based key
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;
    const fileKey = resolveSigningKey();

    // Second call with env var should use the env var, not the file
    process.env.ACTOR_TOKEN_SIGNING_KEY = "cd".repeat(32);
    const envKey = resolveSigningKey();

    expect(envKey.toString("hex")).toBe("cd".repeat(32));
    expect(envKey.toString("hex")).not.toBe(fileKey.toString("hex"));
  });
});
