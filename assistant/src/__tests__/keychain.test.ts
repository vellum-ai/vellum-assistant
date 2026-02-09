import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

let mockPlatform = 'darwin';
let execFileCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
let execFileResults: Map<string, string | Error> = new Map();

mock.module('../util/platform.js', () => ({
  isMacOS: () => mockPlatform === 'darwin',
  isLinux: () => mockPlatform === 'linux',
  isWindows: () => mockPlatform === 'win32',
  getDataDir: () => '/tmp/vellum-test',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('node:child_process', () => ({
  execFileSync: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    execFileCalls.push({ cmd, args: [...args], opts: { ...opts } });

    // Build a key from the command for result lookup
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, result] of execFileResults) {
      if (key.includes(pattern)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    // Default: return empty string (success)
    return '';
  },
}));

import {
  isKeychainAvailable,
  getKey,
  setKey,
  deleteKey,
} from '../security/keychain.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('keychain', () => {
  beforeEach(() => {
    execFileCalls = [];
    execFileResults = new Map();
    mockPlatform = 'darwin';
  });

  // -----------------------------------------------------------------------
  // isKeychainAvailable
  // -----------------------------------------------------------------------
  describe('isKeychainAvailable', () => {
    test('returns true on macOS when security CLI works', () => {
      mockPlatform = 'darwin';
      expect(isKeychainAvailable()).toBe(true);
      expect(execFileCalls[0].cmd).toBe('security');
      expect(execFileCalls[0].args).toContain('list-keychains');
    });

    test('returns true on Linux when secret-tool exists', () => {
      mockPlatform = 'linux';
      expect(isKeychainAvailable()).toBe(true);
      expect(execFileCalls[0].cmd).toBe('which');
      expect(execFileCalls[0].args).toContain('secret-tool');
    });

    test('returns false on unsupported platform', () => {
      mockPlatform = 'win32';
      expect(isKeychainAvailable()).toBe(false);
    });

    test('returns false when CLI command fails', () => {
      mockPlatform = 'darwin';
      execFileResults.set('list-keychains', new Error('not found'));
      expect(isKeychainAvailable()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // macOS getKey / setKey / deleteKey
  // -----------------------------------------------------------------------
  describe('macOS', () => {
    beforeEach(() => {
      mockPlatform = 'darwin';
    });

    test('getKey calls security find-generic-password', () => {
      execFileResults.set('find-generic-password', 'my-secret-value\n');
      const result = getKey('anthropic');
      expect(result).toBe('my-secret-value');
      const call = execFileCalls.find((c) => c.args.includes('find-generic-password'));
      expect(call).toBeDefined();
      expect(call!.args).toContain('-s');
      expect(call!.args).toContain('vellum-assistant');
      expect(call!.args).toContain('-a');
      expect(call!.args).toContain('anthropic');
      expect(call!.args).toContain('-w');
    });

    test('getKey returns undefined when key not found', () => {
      execFileResults.set('find-generic-password', new Error('item not found'));
      expect(getKey('nonexistent')).toBeUndefined();
    });

    test('setKey calls security add-generic-password with -U flag', () => {
      const result = setKey('anthropic', 'sk-ant-key123');
      expect(result).toBe(true);
      const addCall = execFileCalls.find((c) => c.args.includes('add-generic-password'));
      expect(addCall).toBeDefined();
      expect(addCall!.args).toContain('-U');
      expect(addCall!.args).toContain('-w');
    });

    test('setKey passes secret as -w argument', () => {
      setKey('anthropic', 'sk-ant-key123');
      const addCall = execFileCalls.find((c) => c.args.includes('add-generic-password'));
      expect(addCall).toBeDefined();
      // macOS security CLI requires password as the -w argument value
      const wIndex = addCall!.args.indexOf('-w');
      expect(wIndex).toBeGreaterThanOrEqual(0);
      expect(addCall!.args[wIndex + 1]).toBe('sk-ant-key123');
    });

    test('setKey does not delete before adding (relies on -U flag)', () => {
      setKey('anthropic', 'new-value');
      const deleteCall = execFileCalls.find((c) => c.args.includes('delete-generic-password'));
      expect(deleteCall).toBeUndefined();
    });

    test('getKey preserves internal whitespace', () => {
      execFileResults.set('find-generic-password', ' value with spaces \n');
      const result = getKey('test');
      expect(result).toBe(' value with spaces ');
    });

    test('deleteKey calls security delete-generic-password', () => {
      const result = deleteKey('anthropic');
      expect(result).toBe(true);
      const call = execFileCalls.find((c) => c.args.includes('delete-generic-password'));
      expect(call).toBeDefined();
      expect(call!.args).toContain('vellum-assistant');
      expect(call!.args).toContain('anthropic');
    });

    test('deleteKey returns false on error', () => {
      execFileResults.set('delete-generic-password', new Error('item not found'));
      expect(deleteKey('nonexistent')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Linux getKey / setKey / deleteKey
  // -----------------------------------------------------------------------
  describe('Linux', () => {
    beforeEach(() => {
      mockPlatform = 'linux';
    });

    test('getKey calls secret-tool lookup', () => {
      execFileResults.set('lookup', 'linux-secret-value\n');
      const result = getKey('openai');
      expect(result).toBe('linux-secret-value');
      const call = execFileCalls.find((c) => c.cmd === 'secret-tool' && c.args.includes('lookup'));
      expect(call).toBeDefined();
      expect(call!.args).toContain('service');
      expect(call!.args).toContain('vellum-assistant');
      expect(call!.args).toContain('account');
      expect(call!.args).toContain('openai');
    });

    test('getKey returns undefined when key not found', () => {
      execFileResults.set('lookup', new Error('not found'));
      expect(getKey('missing')).toBeUndefined();
    });

    test('getKey preserves internal whitespace', () => {
      execFileResults.set('lookup', ' value with spaces \n');
      const result = getKey('test');
      expect(result).toBe(' value with spaces ');
    });

    test('setKey calls secret-tool store with input', () => {
      const result = setKey('gemini', 'gemini-key-123');
      expect(result).toBe(true);
      const call = execFileCalls.find((c) => c.cmd === 'secret-tool' && c.args.includes('store'));
      expect(call).toBeDefined();
      expect(call!.args).toContain('--label');
      expect(call!.opts.input).toBe('gemini-key-123');
    });

    test('deleteKey calls secret-tool clear', () => {
      const result = deleteKey('gemini');
      expect(result).toBe(true);
      const call = execFileCalls.find((c) => c.cmd === 'secret-tool' && c.args.includes('clear'));
      expect(call).toBeDefined();
      expect(call!.args).toContain('vellum-assistant');
      expect(call!.args).toContain('gemini');
    });
  });

  // -----------------------------------------------------------------------
  // Unsupported platform
  // -----------------------------------------------------------------------
  describe('unsupported platform', () => {
    beforeEach(() => {
      mockPlatform = 'win32';
    });

    test('getKey returns undefined', () => {
      expect(getKey('any')).toBeUndefined();
    });

    test('setKey returns false', () => {
      expect(setKey('any', 'value')).toBe(false);
    });

    test('deleteKey returns false', () => {
      expect(deleteKey('any')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    test('getKey gracefully handles unexpected errors', () => {
      mockPlatform = 'darwin';
      execFileResults.set('find-generic-password', new Error('unexpected'));
      expect(getKey('key')).toBeUndefined();
    });

    test('setKey gracefully handles unexpected errors', () => {
      mockPlatform = 'darwin';
      execFileResults.set('add-generic-password', new Error('unexpected'));
      expect(setKey('key', 'val')).toBe(false);
    });
  });
});
