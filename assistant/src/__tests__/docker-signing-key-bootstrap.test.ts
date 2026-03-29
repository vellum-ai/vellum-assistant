/**
 * Tests for resolveSigningKey() covering env var injection (Docker)
 * and file-based load/create (local mode).
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "signing-key-test-")));
process.env.VELLUM_HOME = testDir;
process.env.VELLUM_WORKSPACE_DIR = testDir;

// Mock homedir() so the hardcoded LEGACY_SIGNING_KEY_PATH resolves inside
// the temp test directory instead of the real ~/.vellum/protected/.
mock.module("node:os", () => ({
  homedir: () => testDir,
  tmpdir,
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
  process.env.VELLUM_HOME = testDir;
  process.env.VELLUM_WORKSPACE_DIR = testDir;
  savedEnv.ACTOR_TOKEN_SIGNING_KEY = process.env.ACTOR_TOKEN_SIGNING_KEY;
  // Clean up key files from previous tests so they don't leak between cases.
  rmSync(join(testDir, ".vellum"), { recursive: true, force: true });
  mkdirSync(join(testDir, ".vellum", "protected"), { recursive: true });
});

afterEach(() => {
  delete process.env.VELLUM_HOME;
  delete process.env.VELLUM_WORKSPACE_DIR;
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

    expect(() => resolveSigningKey()).toThrow(
      "Invalid ACTOR_TOKEN_SIGNING_KEY",
    );
  });

  test("falls back to disk when env var is not set", () => {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    // resolveSigningKey now falls back to loadOrCreateSigningKey()
    // which will generate a new key on disk.
    const key = resolveSigningKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  test("reads existing key from legacy protected/ path when env var is not set", () => {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    // Write a known key to the legacy protected/ location
    const legacyKey = Buffer.alloc(32, 0xaa);
    // LEGACY_SIGNING_KEY_PATH = join(homedir(), ".vellum", "protected", "actor-token-signing-key")
    // homedir() is mocked to testDir
    const legacyPath = join(
      testDir,
      ".vellum",
      "protected",
      "actor-token-signing-key",
    );
    mkdirSync(join(testDir, ".vellum", "protected"), { recursive: true });
    writeFileSync(legacyPath, legacyKey, { mode: 0o600 });

    const key = resolveSigningKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(legacyKey.toString("hex"));
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
