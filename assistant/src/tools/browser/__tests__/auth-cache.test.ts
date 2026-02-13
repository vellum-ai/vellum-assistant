import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthSessionCache } from '../auth-cache.js';

// Use a unique temp directory for each test run
let testDir: string;

function createTempDir(): string {
  const dir = join(tmpdir(), `auth-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('AuthSessionCache', () => {
  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── markAuthenticated ───────────────────────────────────────

  describe('markAuthenticated', () => {
    test('stores a session for a domain', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('example.com', 'jit');

      const sessions = cache.getAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].domain).toBe('example.com');
      expect(sessions[0].method).toBe('jit');
      expect(sessions[0].authenticatedAt).toBeGreaterThan(0);
      expect(sessions[0].expiresAt).toBeGreaterThan(Date.now());
    });

    test('stores session with stored method', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('github.com', 'stored');

      const sessions = cache.getAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].method).toBe('stored');
    });

    test('overwrites existing session for the same domain', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('example.com', 'jit');
      cache.markAuthenticated('example.com', 'stored');

      const sessions = cache.getAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].method).toBe('stored');
    });
  });

  // ── isAuthenticated ─────────────────────────────────────────

  describe('isAuthenticated', () => {
    test('returns true for a valid session', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('example.com', 'jit');
      expect(cache.isAuthenticated('example.com')).toBe(true);
    });

    test('returns false for unknown domain', () => {
      const cache = new AuthSessionCache(testDir);
      expect(cache.isAuthenticated('unknown.com')).toBe(false);
    });

    test('returns false for expired session', () => {
      // Use a very short expiry (1ms)
      const cache = new AuthSessionCache(testDir, 1);
      cache.markAuthenticated('example.com', 'jit');

      // Wait a small amount to ensure expiry
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy-wait
      }

      expect(cache.isAuthenticated('example.com')).toBe(false);
    });

    test('cleans up expired session from cache on check', () => {
      const cache = new AuthSessionCache(testDir, 1);
      cache.markAuthenticated('example.com', 'jit');

      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy-wait
      }

      cache.isAuthenticated('example.com');
      expect(cache.getAll()).toHaveLength(0);
    });
  });

  // ── invalidate ──────────────────────────────────────────────

  describe('invalidate', () => {
    test('removes a session for a domain', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('example.com', 'jit');
      expect(cache.isAuthenticated('example.com')).toBe(true);

      cache.invalidate('example.com');
      expect(cache.isAuthenticated('example.com')).toBe(false);
      expect(cache.getAll()).toHaveLength(0);
    });

    test('is safe to call for non-existent domain', () => {
      const cache = new AuthSessionCache(testDir);
      cache.invalidate('nonexistent.com');
      // Should not throw
    });
  });

  // ── load and save round-trip ────────────────────────────────

  describe('load and save', () => {
    test('round-trips sessions through disk', async () => {
      const cache1 = new AuthSessionCache(testDir);
      cache1.markAuthenticated('example.com', 'jit');
      cache1.markAuthenticated('github.com', 'stored');

      // Wait briefly for fire-and-forget save to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const cache2 = new AuthSessionCache(testDir);
      await cache2.load();

      expect(cache2.isAuthenticated('example.com')).toBe(true);
      expect(cache2.isAuthenticated('github.com')).toBe(true);

      const sessions = cache2.getAll();
      expect(sessions).toHaveLength(2);
    });

    test('persists to the expected file path', async () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('example.com', 'jit');

      await new Promise(resolve => setTimeout(resolve, 50));

      const filePath = join(testDir, 'browser-auth', 'sessions.json');
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data).toHaveLength(1);
      expect(data[0].domain).toBe('example.com');
    });

    test('handles missing file gracefully on load', async () => {
      const cache = new AuthSessionCache(testDir);
      await cache.load();
      expect(cache.getAll()).toHaveLength(0);
    });

    test('handles corrupted file gracefully on load', async () => {
      const dir = join(testDir, 'browser-auth');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, 'sessions.json');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, 'not valid json!!!', 'utf-8');

      const cache = new AuthSessionCache(testDir);
      await cache.load();
      expect(cache.getAll()).toHaveLength(0);
    });
  });

  // ── domain normalization ────────────────────────────────────

  describe('domain normalization', () => {
    test('www.google.com matches google.com', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('www.google.com', 'jit');
      expect(cache.isAuthenticated('google.com')).toBe(true);
    });

    test('google.com matches www.google.com lookup', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('google.com', 'jit');
      expect(cache.isAuthenticated('www.google.com')).toBe(true);
    });

    test('domain lookup is case-insensitive', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('GitHub.COM', 'stored');
      expect(cache.isAuthenticated('github.com')).toBe(true);
      expect(cache.isAuthenticated('GITHUB.COM')).toBe(true);
    });

    test('normalized domain is stored', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('WWW.Example.COM', 'jit');

      const sessions = cache.getAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].domain).toBe('example.com');
    });
  });

  // ── expired sessions cleaned up on load ─────────────────────

  describe('expired session cleanup on load', () => {
    test('expired sessions are removed during load', async () => {
      const cache1 = new AuthSessionCache(testDir, 1);
      cache1.markAuthenticated('expired.com', 'jit');

      // Wait for save and for the session to expire
      await new Promise(resolve => setTimeout(resolve, 50));

      const cache2 = new AuthSessionCache(testDir);
      await cache2.load();

      expect(cache2.isAuthenticated('expired.com')).toBe(false);
      expect(cache2.getAll()).toHaveLength(0);
    });

    test('only expired sessions are removed, valid ones kept', async () => {
      // Create one session that expires quickly and one that doesn't
      const cache1 = new AuthSessionCache(testDir, 1);
      cache1.markAuthenticated('expired.com', 'jit');

      // Wait for it to expire and save
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now add a long-lived session to the same cache dir
      const cache1b = new AuthSessionCache(testDir);
      await cache1b.load();
      cache1b.markAuthenticated('valid.com', 'stored');

      await new Promise(resolve => setTimeout(resolve, 50));

      // Load again in a fresh cache
      const cache2 = new AuthSessionCache(testDir);
      await cache2.load();

      expect(cache2.isAuthenticated('expired.com')).toBe(false);
      expect(cache2.isAuthenticated('valid.com')).toBe(true);
      expect(cache2.getAll()).toHaveLength(1);
    });
  });

  // ── getAll ──────────────────────────────────────────────────

  describe('getAll', () => {
    test('returns empty array when no sessions', () => {
      const cache = new AuthSessionCache(testDir);
      expect(cache.getAll()).toEqual([]);
    });

    test('returns all stored sessions', () => {
      const cache = new AuthSessionCache(testDir);
      cache.markAuthenticated('a.com', 'jit');
      cache.markAuthenticated('b.com', 'stored');
      cache.markAuthenticated('c.com', 'jit');

      expect(cache.getAll()).toHaveLength(3);
    });
  });
});
