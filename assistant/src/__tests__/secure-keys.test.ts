import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock logger (no-op — compatible with other test files' identical mock)
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Keychain simulation via _overrideDeps — avoids process-global mock.module
// for keychain.js which leaks into keychain.test.ts.
// ---------------------------------------------------------------------------

import { _overrideDeps, _resetDeps } from '../security/keychain.js';

let keychainAvailable = false;
let keychainFailAtRuntime = false;
const keychainStore = new Map<string, string>();

function installKeychainDeps(): void {
  _overrideDeps({
    isMacOS: () => keychainAvailable,
    isLinux: () => false,
    execFileSync: ((cmd: string, args: string[]) => {
      if (keychainFailAtRuntime) throw new Error('Keychain runtime error');

      if (cmd === 'security') {
        if (args.includes('list-keychains')) return '';

        if (args.includes('find-generic-password')) {
          const aIdx = args.indexOf('-a');
          const account = args[aIdx + 1];
          const val = keychainStore.get(account);
          if (!val) throw Object.assign(new Error('not found'), { status: 44 });
          return val + '\n';
        }

        if (args.includes('add-generic-password')) {
          const aIdx = args.indexOf('-a');
          const account = args[aIdx + 1];
          const wIdx = args.indexOf('-w');
          const value = args[wIdx + 1];
          keychainStore.set(account, value);
          return '';
        }

        if (args.includes('delete-generic-password')) {
          const aIdx = args.indexOf('-a');
          const account = args[aIdx + 1];
          keychainStore.delete(account);
          return '';
        }
      }

      return '';
    }) as typeof import('node:child_process').execFileSync,
  });
}

import {
  getSecureKey,
  setSecureKey,
  deleteSecureKey,
  listSecureKeys,
  _resetBackend,
  _setBackend,
} from '../security/secure-keys.js';
import { _setStorePath } from '../security/encrypted-store.js';

// ---------------------------------------------------------------------------
// Use a temp directory for encrypted store tests
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-seckeys-test-${randomBytes(4).toString('hex')}`);
const STORE_PATH = join(TEST_DIR, 'keys.enc');

describe('secure-keys', () => {
  beforeEach(() => {
    // Clean state
    keychainAvailable = false;
    keychainFailAtRuntime = false;
    keychainStore.clear();
    _resetBackend();
    installKeychainDeps();

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
  });

  afterEach(() => {
    _setStorePath(null);
    _resetBackend();
  });

  afterAll(() => {
    _resetDeps();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -----------------------------------------------------------------------
  // Backend selection
  // -----------------------------------------------------------------------
  describe('backend selection', () => {
    test('uses encrypted store when keychain is unavailable', () => {
      keychainAvailable = false;
      _resetBackend();
      setSecureKey('anthropic', 'sk-test-123');
      expect(getSecureKey('anthropic')).toBe('sk-test-123');
      // Should be in encrypted store, not keychain
      expect(keychainStore.has('anthropic')).toBe(false);
      expect(existsSync(STORE_PATH)).toBe(true);
    });

    test('uses keychain when available', () => {
      keychainAvailable = true;
      _resetBackend();
      setSecureKey('anthropic', 'sk-test-456');
      expect(getSecureKey('anthropic')).toBe('sk-test-456');
      // Should be in keychain, not encrypted store
      expect(keychainStore.get('anthropic')).toBe('sk-test-456');
      expect(existsSync(STORE_PATH)).toBe(false);
    });

    test('caches backend selection', () => {
      keychainAvailable = false;
      _resetBackend();
      setSecureKey('test', 'val1');

      // Change availability — should still use encrypted store
      keychainAvailable = true;
      setSecureKey('test2', 'val2');
      expect(keychainStore.has('test2')).toBe(false);
      expect(existsSync(STORE_PATH)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // CRUD operations (via encrypted store backend)
  // -----------------------------------------------------------------------
  describe('CRUD with encrypted backend', () => {
    test('set and get a key', () => {
      setSecureKey('openai', 'sk-openai-789');
      expect(getSecureKey('openai')).toBe('sk-openai-789');
    });

    test('get returns undefined for nonexistent key', () => {
      expect(getSecureKey('nonexistent')).toBeUndefined();
    });

    test('delete removes a key', () => {
      setSecureKey('gemini', 'gem-key');
      expect(deleteSecureKey('gemini')).toBe(true);
      expect(getSecureKey('gemini')).toBeUndefined();
    });

    test('delete returns false for nonexistent key', () => {
      expect(deleteSecureKey('missing')).toBe(false);
    });

    test('listSecureKeys returns all keys', () => {
      setSecureKey('anthropic', 'val1');
      setSecureKey('openai', 'val2');
      const keys = listSecureKeys();
      expect(keys).toContain('anthropic');
      expect(keys).toContain('openai');
      expect(keys.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // CRUD operations (via keychain backend)
  // -----------------------------------------------------------------------
  describe('CRUD with keychain backend', () => {
    beforeEach(() => {
      keychainAvailable = true;
      _resetBackend();
    });

    test('set and get a key', () => {
      setSecureKey('anthropic', 'sk-ant-123');
      expect(getSecureKey('anthropic')).toBe('sk-ant-123');
    });

    test('delete removes a key', () => {
      setSecureKey('anthropic', 'sk-ant-123');
      deleteSecureKey('anthropic');
      expect(getSecureKey('anthropic')).toBeUndefined();
    });

    test('listSecureKeys returns empty for keychain backend', () => {
      setSecureKey('anthropic', 'val');
      // Keychain doesn't support listing
      expect(listSecureKeys()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // _setBackend
  // -----------------------------------------------------------------------
  describe('_setBackend', () => {
    test('forces encrypted backend', () => {
      _setBackend('encrypted');
      setSecureKey('test', 'value');
      expect(existsSync(STORE_PATH)).toBe(true);
      expect(keychainStore.has('test')).toBe(false);
    });

    test('forces keychain backend', () => {
      keychainAvailable = true;
      _setBackend('keychain');
      setSecureKey('test', 'value');
      expect(keychainStore.get('test')).toBe('value');
    });

    test('reset re-evaluates backend', () => {
      keychainAvailable = true;
      _setBackend('keychain');
      setSecureKey('k1', 'v1');
      expect(keychainStore.get('k1')).toBe('v1');

      _setBackend(undefined); // reset
      keychainAvailable = false;
      setSecureKey('k2', 'v2');
      expect(keychainStore.has('k2')).toBe(false);
      expect(getSecureKey('k2')).toBe('v2');
    });
  });

  // -----------------------------------------------------------------------
  // Keychain runtime failure fallback
  // -----------------------------------------------------------------------
  describe('keychain runtime fallback', () => {
    beforeEach(() => {
      keychainAvailable = true;
      _resetBackend();
    });

    test('setSecureKey falls back to encrypted store when keychain fails at runtime', () => {
      keychainFailAtRuntime = true;
      const result = setSecureKey('anthropic', 'sk-test-fallback');
      expect(result).toBe(true);
      // Should have stored in encrypted store
      expect(keychainStore.has('anthropic')).toBe(false);
      expect(existsSync(STORE_PATH)).toBe(true);
      // Subsequent gets should also use encrypted store now
      expect(getSecureKey('anthropic')).toBe('sk-test-fallback');
    });

    test('deleteSecureKey for nonexistent key does not downgrade backend', () => {
      // Deleting a key that doesn't exist should NOT trigger a downgrade
      const result = deleteSecureKey('nonexistent');
      expect(result).toBe(false);
      // Backend should still be keychain — verify by storing a new key
      setSecureKey('anthropic', 'sk-still-keychain');
      expect(keychainStore.get('anthropic')).toBe('sk-still-keychain');
      expect(existsSync(STORE_PATH)).toBe(false);
    });

    test('deleteSecureKey falls back to encrypted store when keychain fails at runtime', () => {
      // First store successfully in encrypted store via fallback
      keychainFailAtRuntime = true;
      setSecureKey('openai', 'sk-openai-test');
      // Delete should also use encrypted store
      const result = deleteSecureKey('openai');
      expect(result).toBe(true);
      expect(getSecureKey('openai')).toBeUndefined();
    });

    test('deleteSecureKey triggers downgrade when key exists in keychain but keychain starts failing', () => {
      // Step 1: Store a key while keychain is working
      setSecureKey('anthropic', 'sk-ant-exists');
      expect(keychainStore.get('anthropic')).toBe('sk-ant-exists');

      // Step 2: Keychain starts failing at runtime
      keychainFailAtRuntime = true;

      // Step 3: Attempt to delete — should trigger fallback/downgrade
      const result = deleteSecureKey('anthropic');
      // deleteKey returns false because keychain is failing, and fallback
      // encrypted store doesn't have the key, so the overall result is false.
      // But the important thing is that the backend was downgraded.
      expect(result).toBe(false);

      // Step 4: Verify the backend has been downgraded to encrypted store.
      // Subsequent operations should use encrypted store.
      keychainFailAtRuntime = false;
      setSecureKey('openai', 'sk-openai-new');
      // Should be in encrypted store, not keychain
      expect(keychainStore.has('openai')).toBe(false);
      expect(getSecureKey('openai')).toBe('sk-openai-new');
    });

    test('backend permanently downgrades after keychain runtime failure', () => {
      // Start with working keychain
      setSecureKey('anthropic', 'key1');
      expect(keychainStore.get('anthropic')).toBe('key1');

      // Keychain starts failing
      keychainFailAtRuntime = true;
      setSecureKey('openai', 'key2');

      // Backend should now be encrypted — even if keychain "recovers"
      keychainFailAtRuntime = false;
      setSecureKey('gemini', 'key3');
      // gemini should be in encrypted store, not keychain
      expect(keychainStore.has('gemini')).toBe(false);
      expect(getSecureKey('gemini')).toBe('key3');
    });
  });
});
