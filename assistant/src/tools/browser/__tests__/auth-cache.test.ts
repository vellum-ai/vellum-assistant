import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type AuthSession, AuthSessionCache } from "../auth-cache.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `auth-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSessionsFile(dataDir: string, sessions: AuthSession[]): void {
  const dir = join(dataDir, "browser-auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sessions.json"),
    JSON.stringify(sessions, null, 2),
    "utf-8",
  );
}

describe("AuthSessionCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("isAuthenticated returns true after markAuthenticated", async () => {
    const cache = new AuthSessionCache(tmpDir);
    await cache.load();
    cache.markAuthenticated("example.com", "jit");
    expect(cache.isAuthenticated("example.com")).toBe(true);
  });

  test("isAuthenticated returns false for unknown domain", async () => {
    const cache = new AuthSessionCache(tmpDir);
    await cache.load();
    expect(cache.isAuthenticated("unknown.com")).toBe(false);
  });

  test("isAuthenticated returns false for expired session", async () => {
    const expired: AuthSession[] = [
      {
        domain: "expired.com",
        authenticatedAt: Date.now() - 60_000,
        expiresAt: Date.now() - 1_000,
        method: "jit",
      },
    ];
    writeSessionsFile(tmpDir, expired);
    const cache = new AuthSessionCache(tmpDir);
    await cache.load();
    expect(cache.isAuthenticated("expired.com")).toBe(false);
  });

  test("load populates sessions from disk", async () => {
    const sessions: AuthSession[] = [
      {
        domain: "disk.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "stored",
      },
    ];
    writeSessionsFile(tmpDir, sessions);
    const cache = new AuthSessionCache(tmpDir);
    await cache.load();
    expect(cache.isAuthenticated("disk.com")).toBe(true);
  });

  test("isAuthenticated works correctly before load() is called via ensureLoaded", () => {
    // Simulate sessions existing on disk before the cache is created
    const sessions: AuthSession[] = [
      {
        domain: "preloaded.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "stored",
      },
    ];
    writeSessionsFile(tmpDir, sessions);

    // Create a fresh cache -- load() has NOT been called
    const cache = new AuthSessionCache(tmpDir);

    // Before the fix, this would return false because sessions hadn't been
    // loaded from disk yet. With ensureLoaded(), isAuthenticated() now
    // synchronously reads sessions on first call.
    expect(cache.isAuthenticated("preloaded.com")).toBe(true);
  });

  test("ensureLoaded is a no-op after load() has been called", async () => {
    const sessions: AuthSession[] = [
      {
        domain: "loaded.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "jit",
      },
    ];
    writeSessionsFile(tmpDir, sessions);

    const cache = new AuthSessionCache(tmpDir);
    await cache.load();

    // Add an in-memory session after load
    cache.markAuthenticated("inmemory.com", "jit");

    // ensureLoaded should not re-read from disk and clobber in-memory state
    cache.ensureLoaded();
    expect(cache.isAuthenticated("inmemory.com")).toBe(true);
    expect(cache.isAuthenticated("loaded.com")).toBe(true);
  });

  test("ensureLoaded skips expired sessions", () => {
    const sessions: AuthSession[] = [
      {
        domain: "valid.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "jit",
      },
      {
        domain: "stale.com",
        authenticatedAt: Date.now() - 60_000,
        expiresAt: Date.now() - 1_000,
        method: "stored",
      },
    ];
    writeSessionsFile(tmpDir, sessions);

    const cache = new AuthSessionCache(tmpDir);
    // Without calling load(), isAuthenticated triggers ensureLoaded
    expect(cache.isAuthenticated("valid.com")).toBe(true);
    expect(cache.isAuthenticated("stale.com")).toBe(false);
  });

  test("markAuthenticated on fresh cache preserves existing sessions on disk", () => {
    // Write pre-existing sessions to disk
    const sessions: AuthSession[] = [
      {
        domain: "existing.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "stored",
      },
    ];
    writeSessionsFile(tmpDir, sessions);

    // Create a fresh cache - load() has NOT been called
    const cache = new AuthSessionCache(tmpDir);

    // markAuthenticated should ensureLoaded first, so existing sessions
    // are not clobbered when save() writes to disk
    cache.markAuthenticated("newdomain.com", "jit");

    // Verify existing session is still present
    expect(cache.isAuthenticated("existing.com")).toBe(true);
    expect(cache.isAuthenticated("newdomain.com")).toBe(true);

    // Double-check by loading a second cache instance from the same disk file
    const cache2 = new AuthSessionCache(tmpDir);
    expect(cache2.isAuthenticated("existing.com")).toBe(true);
    expect(cache2.isAuthenticated("newdomain.com")).toBe(true);
  });

  test("invalidate on fresh cache preserves unrelated sessions on disk", () => {
    // Write pre-existing sessions to disk
    const sessions: AuthSession[] = [
      {
        domain: "keep-me.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "stored",
      },
      {
        domain: "remove-me.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "jit",
      },
    ];
    writeSessionsFile(tmpDir, sessions);

    // Create a fresh cache - load() has NOT been called
    const cache = new AuthSessionCache(tmpDir);

    // invalidate should ensureLoaded first, so unrelated sessions
    // are not clobbered when save() writes to disk
    cache.invalidate("remove-me.com");

    // Verify the targeted session is gone but the other is preserved
    expect(cache.isAuthenticated("remove-me.com")).toBe(false);
    expect(cache.isAuthenticated("keep-me.com")).toBe(true);

    // Double-check by loading a second cache instance from the same disk file
    const cache2 = new AuthSessionCache(tmpDir);
    expect(cache2.isAuthenticated("remove-me.com")).toBe(false);
    expect(cache2.isAuthenticated("keep-me.com")).toBe(true);
  });

  test("domain normalization: www prefix and case insensitivity", () => {
    const sessions: AuthSession[] = [
      {
        domain: "example.com",
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        method: "jit",
      },
    ];
    writeSessionsFile(tmpDir, sessions);

    const cache = new AuthSessionCache(tmpDir);
    expect(cache.isAuthenticated("www.Example.COM")).toBe(true);
    expect(cache.isAuthenticated("EXAMPLE.COM")).toBe(true);
  });
});
