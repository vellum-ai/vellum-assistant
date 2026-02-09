import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock only the logger (not platform — we use _setStorePath instead)
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  getKey,
  setKey,
  deleteKey,
  listKeys,
  _setStorePath,
} from '../security/encrypted-store.js';

// ---------------------------------------------------------------------------
// Use a temp directory so tests don't touch the real ~/.vellum
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-enc-test-${randomBytes(4).toString('hex')}`);
const STORE_PATH = join(TEST_DIR, 'keys.enc');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('encrypted-store', () => {
  beforeEach(() => {
    // Ensure clean temp directory and point store at it
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
  });

  afterEach(() => {
    _setStorePath(null);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -----------------------------------------------------------------------
  // Basic CRUD
  // -----------------------------------------------------------------------
  describe('basic operations', () => {
    test('setKey creates the store file and returns true', () => {
      const result = setKey('anthropic', 'sk-ant-key123');
      expect(result).toBe(true);
      expect(existsSync(STORE_PATH)).toBe(true);
    });

    test('getKey retrieves a previously stored value', () => {
      setKey('anthropic', 'sk-ant-key123');
      const result = getKey('anthropic');
      expect(result).toBe('sk-ant-key123');
    });

    test('getKey returns undefined for nonexistent key', () => {
      expect(getKey('nonexistent')).toBeUndefined();
    });

    test('getKey returns undefined when store file does not exist', () => {
      expect(getKey('anything')).toBeUndefined();
    });

    test('setKey overwrites existing value', () => {
      setKey('anthropic', 'old-value');
      setKey('anthropic', 'new-value');
      expect(getKey('anthropic')).toBe('new-value');
    });

    test('deleteKey removes an entry and returns true', () => {
      setKey('anthropic', 'sk-ant-key123');
      const result = deleteKey('anthropic');
      expect(result).toBe(true);
      expect(getKey('anthropic')).toBeUndefined();
    });

    test('deleteKey returns false for nonexistent key', () => {
      setKey('anthropic', 'value');
      expect(deleteKey('nonexistent')).toBe(false);
    });

    test('deleteKey returns false when store does not exist', () => {
      expect(deleteKey('anything')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple keys
  // -----------------------------------------------------------------------
  describe('multiple keys', () => {
    test('stores and retrieves multiple independent keys', () => {
      setKey('anthropic', 'sk-ant-123');
      setKey('openai', 'sk-openai-456');
      setKey('gemini', 'gem-key-789');

      expect(getKey('anthropic')).toBe('sk-ant-123');
      expect(getKey('openai')).toBe('sk-openai-456');
      expect(getKey('gemini')).toBe('gem-key-789');
    });

    test('deleting one key does not affect others', () => {
      setKey('anthropic', 'val-1');
      setKey('openai', 'val-2');
      deleteKey('anthropic');

      expect(getKey('anthropic')).toBeUndefined();
      expect(getKey('openai')).toBe('val-2');
    });
  });

  // -----------------------------------------------------------------------
  // listKeys
  // -----------------------------------------------------------------------
  describe('listKeys', () => {
    test('returns empty array when store does not exist', () => {
      expect(listKeys()).toEqual([]);
    });

    test('returns all stored account names', () => {
      setKey('anthropic', 'val-1');
      setKey('openai', 'val-2');
      const keys = listKeys();
      expect(keys).toContain('anthropic');
      expect(keys).toContain('openai');
      expect(keys.length).toBe(2);
    });

    test('reflects deletions', () => {
      setKey('anthropic', 'val-1');
      setKey('openai', 'val-2');
      deleteKey('anthropic');
      expect(listKeys()).toEqual(['openai']);
    });
  });

  // -----------------------------------------------------------------------
  // Store format
  // -----------------------------------------------------------------------
  describe('store format', () => {
    test('store file is valid JSON with version, salt, and entries', () => {
      setKey('test', 'value');
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(typeof parsed.salt).toBe('string');
      expect(parsed.salt.length).toBe(64); // 32 bytes = 64 hex chars
      expect(typeof parsed.entries).toBe('object');
      expect(parsed.entries.test).toBeDefined();
    });

    test('each entry has iv, tag, and data fields', () => {
      setKey('test', 'value');
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      const entry = parsed.entries.test;
      expect(typeof entry.iv).toBe('string');
      expect(entry.iv.length).toBe(32); // 16 bytes = 32 hex chars
      expect(typeof entry.tag).toBe('string');
      expect(entry.tag.length).toBe(32); // 16 bytes = 32 hex chars
      expect(typeof entry.data).toBe('string');
      expect(entry.data.length).toBeGreaterThan(0);
    });

    test('ciphertext does not contain the plaintext value', () => {
      const secret = 'super-secret-api-key-12345';
      setKey('test', secret);
      const raw = readFileSync(STORE_PATH, 'utf-8');
      expect(raw).not.toContain(secret);
    });

    test('different values produce different ciphertexts (unique IVs)', () => {
      setKey('key1', 'same-value');
      const raw1 = readFileSync(STORE_PATH, 'utf-8');
      const entry1 = JSON.parse(raw1).entries.key1;

      // Delete and re-set to get a new IV
      deleteKey('key1');
      setKey('key1', 'same-value');
      const raw2 = readFileSync(STORE_PATH, 'utf-8');
      const entry2 = JSON.parse(raw2).entries.key1;

      // IVs should differ (random), so ciphertext should differ too
      expect(entry1.iv).not.toBe(entry2.iv);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    test('getKey returns undefined for corrupted store file', () => {
      writeFileSync(STORE_PATH, 'not valid json');
      expect(getKey('test')).toBeUndefined();
    });

    test('getKey returns undefined for invalid store version', () => {
      writeFileSync(STORE_PATH, JSON.stringify({
        version: 99,
        salt: 'abc',
        entries: {},
      }));
      expect(getKey('test')).toBeUndefined();
    });

    test('getKey returns undefined when entry has tampered ciphertext', () => {
      setKey('test', 'secret');
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      // Flip a byte in the ciphertext
      const data = parsed.entries.test.data;
      const flipped = data[0] === '0' ? '1' + data.slice(1) : '0' + data.slice(1);
      parsed.entries.test.data = flipped;
      writeFileSync(STORE_PATH, JSON.stringify(parsed));
      // GCM auth should fail
      expect(getKey('test')).toBeUndefined();
    });

    test('getKey returns undefined when auth tag is tampered', () => {
      setKey('test', 'secret');
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      // Flip a byte in the auth tag
      const tag = parsed.entries.test.tag;
      const flipped = tag[0] === '0' ? '1' + tag.slice(1) : '0' + tag.slice(1);
      parsed.entries.test.tag = flipped;
      writeFileSync(STORE_PATH, JSON.stringify(parsed));
      expect(getKey('test')).toBeUndefined();
    });

    test('setKey creates directory if missing', () => {
      // Point to a path in a non-existent subdirectory
      const nestedPath = join(TEST_DIR, 'sub', 'dir', 'keys.enc');
      _setStorePath(nestedPath);
      const result = setKey('test', 'value');
      expect(result).toBe(true);
      expect(getKey('test')).toBe('value');
    });

    test('setKey refuses to overwrite a corrupt store file', () => {
      // Write a valid store first
      setKey('existing', 'old-secret');
      // Corrupt the store
      writeFileSync(STORE_PATH, 'corrupted data');
      // setKey should fail rather than overwrite with new salt
      const result = setKey('new-key', 'new-value');
      expect(result).toBe(false);
    });

    test('setKey refuses to overwrite a store with invalid version', () => {
      writeFileSync(STORE_PATH, JSON.stringify({
        version: 99,
        salt: 'abc',
        entries: {},
      }));
      const result = setKey('test', 'value');
      expect(result).toBe(false);
    });

    test('writeStore enforces 0600 permissions on existing files', () => {
      setKey('test', 'value');
      // Loosen permissions
      chmodSync(STORE_PATH, 0o644);
      // Write again — should re-enforce 0600
      setKey('test2', 'value2');
      const mode = statSync(STORE_PATH).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    test('handles empty string value', () => {
      setKey('empty', '');
      expect(getKey('empty')).toBe('');
    });

    test('handles very long values', () => {
      const longValue = 'x'.repeat(10_000);
      setKey('long', longValue);
      expect(getKey('long')).toBe(longValue);
    });

    test('handles special characters in value', () => {
      const special = '🔑 key=val&foo "bar" \n\t\\';
      setKey('special', special);
      expect(getKey('special')).toBe(special);
    });

    test('handles special characters in account name', () => {
      setKey('my/nested.key', 'value');
      expect(getKey('my/nested.key')).toBe('value');
    });

    test('__proto__ account name works correctly', () => {
      setKey('__proto__', 'proto-value');
      expect(getKey('__proto__')).toBe('proto-value');
      expect(listKeys()).toContain('__proto__');
      deleteKey('__proto__');
      expect(getKey('__proto__')).toBeUndefined();
    });

    test('salt is preserved across set operations', () => {
      setKey('key1', 'val1');
      const raw1 = readFileSync(STORE_PATH, 'utf-8');
      const salt1 = JSON.parse(raw1).salt;

      setKey('key2', 'val2');
      const raw2 = readFileSync(STORE_PATH, 'utf-8');
      const salt2 = JSON.parse(raw2).salt;

      expect(salt1).toBe(salt2);
    });
  });
});
