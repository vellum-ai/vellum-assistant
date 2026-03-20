/**
 * Integration tests for resolveSigningKey() covering the Docker bootstrap
 * lifecycle: fresh fetch from gateway, daemon restart (load from disk),
 * and local mode (file-based load/create).
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Temp directory for signing key persistence
// ---------------------------------------------------------------------------

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "docker-signing-key-test-")));

// ---------------------------------------------------------------------------
// Mock platform to redirect signing key file to our temp directory
// ---------------------------------------------------------------------------

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getDbPath: () => join(testDir, "test.db"),
  normalizeAssistantId: (id: string) => (id === "self" ? "self" : id),
  readLockfile: () => null,
  writeLockfile: () => {},
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

// ---------------------------------------------------------------------------
// Import the functions under test (after mocks are installed)
// ---------------------------------------------------------------------------

const {
  resolveSigningKey,
  loadOrCreateSigningKey,
  BootstrapAlreadyCompleted,
} = await import("../runtime/auth/token-service.js");

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const VALID_32_BYTE_KEY = "ab".repeat(32); // 64 hex chars = 32 bytes
const SIGNING_KEY_PATH = join(testDir, "protected", "actor-token-signing-key");

// ---------------------------------------------------------------------------
// Environment & fetch state management
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

beforeEach(() => {
  saveEnv("IS_CONTAINERIZED", "GATEWAY_INTERNAL_URL");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Docker mode tests — resolveSigningKey() bootstrap lifecycle
// ---------------------------------------------------------------------------

describe("resolveSigningKey — Docker bootstrap lifecycle", () => {
  test("fresh bootstrap: fetches key from gateway and persists to disk", async () => {
    process.env.IS_CONTAINERIZED = "true";
    process.env.GATEWAY_INTERNAL_URL = "http://localhost:19876";

    // Mock fetch to return a known 32-byte key on first call.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ key: VALID_32_BYTE_KEY }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const key = await resolveSigningKey();

    // Verify the returned key is a 32-byte buffer with the expected content.
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(VALID_32_BYTE_KEY);

    // Verify the key was persisted to disk.
    const persisted = readFileSync(SIGNING_KEY_PATH);
    expect(persisted.length).toBe(32);
    expect(Buffer.from(persisted).equals(key)).toBe(true);
  });

  test("daemon restart: gateway returns 403, loads persisted key from disk", async () => {
    process.env.IS_CONTAINERIZED = "true";
    process.env.GATEWAY_INTERNAL_URL = "http://localhost:19876";

    // The previous test persisted the key. Simulate a daemon restart where
    // the gateway returns 403 (bootstrap already completed).
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Bootstrap already completed" }), {
        status: 403,
      })) as unknown as typeof fetch;

    const key = await resolveSigningKey();

    // Should have loaded the previously persisted key from disk.
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(VALID_32_BYTE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Local mode tests — resolveSigningKey() file-based path
// ---------------------------------------------------------------------------

describe("resolveSigningKey — local mode", () => {
  test("uses file-based loadOrCreateSigningKey without calling fetch", async () => {
    // Ensure Docker env vars are unset.
    delete process.env.IS_CONTAINERIZED;
    delete process.env.GATEWAY_INTERNAL_URL;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    }) as unknown as typeof fetch;

    const key = await resolveSigningKey();

    // Should return a valid 32-byte key (loaded from disk or newly created).
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);

    // Crucially, fetch should NOT have been called.
    expect(fetchCalled).toBe(false);
  });

  test("IS_CONTAINERIZED=false does not trigger gateway fetch", async () => {
    process.env.IS_CONTAINERIZED = "false";
    process.env.GATEWAY_INTERNAL_URL = "http://localhost:19876";

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    }) as unknown as typeof fetch;

    const key = await resolveSigningKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(fetchCalled).toBe(false);
  });

  test("IS_CONTAINERIZED=true without GATEWAY_INTERNAL_URL uses local path", async () => {
    process.env.IS_CONTAINERIZED = "true";
    delete process.env.GATEWAY_INTERNAL_URL;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    }) as unknown as typeof fetch;

    const key = await resolveSigningKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(fetchCalled).toBe(false);
  });
});
