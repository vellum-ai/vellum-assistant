import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  isKeychainAvailable,
  getKey,
  setKey,
  deleteKey,
  _overrideDeps,
  _resetDeps,
} from '../security/keychain.js';

// ---------------------------------------------------------------------------
// Test state — uses _overrideDeps instead of mock.module to avoid
// process-global mock leakage between test files in Bun's shared runner.
// ---------------------------------------------------------------------------

let mockPlatform = 'darwin';
let execFileCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
let execFileResults: Map<string, string | Error> = new Map();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('keychain', () => {
  beforeEach(() => {
    execFileCalls = [];
    execFileResults = new Map();
    mockPlatform = 'darwin';

    _overrideDeps({
      isMacOS: () => mockPlatform === 'darwin',
      isLinux: () => mockPlatform === 'linux',
      execFileSync: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
        execFileCalls.push({ cmd, args: [...args], opts: { ...opts } });

        const key = `${cmd} ${args.join(' ')}`;
        for (const [pattern, result] of execFileResults) {
          if (key.includes(pattern)) {
            if (result instanceof Error) throw result;
            return result;
          }
        }
        return '';
      }) as typeof import('node:child_process').execFileSync,
    });
  });

  afterAll(() => {
    _resetDeps();
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

    test('getKey returns null when key not found', () => {
      const err = Object.assign(new Error('item not found'), { status: 44 });
      execFileResults.set('find-generic-password', err);
      expect(getKey('nonexistent')).toBeNull();
    });

    test('getKey throws on runtime errors', () => {
      const err = Object.assign(new Error('keychain locked'), { status: 1 });
      execFileResults.set('find-generic-password', err);
      expect(() => getKey('test')).toThrow('keychain locked');
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

    test('getKey returns null when key not found', () => {
      const err = Object.assign(new Error('not found'), { status: 1 });
      execFileResults.set('lookup', err);
      expect(getKey('missing')).toBeNull();
    });

    test('getKey throws on runtime errors (exit code 1 with stderr)', () => {
      const err = Object.assign(new Error('D-Bus error'), {
        status: 1,
        stderr: 'Cannot autolaunch D-Bus without X11',
      });
      execFileResults.set('lookup', err);
      expect(() => getKey('test')).toThrow('D-Bus error');
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

    test('getKey returns null', () => {
      expect(getKey('any')).toBeNull();
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
    test('getKey throws on unexpected runtime errors', () => {
      mockPlatform = 'darwin';
      const err = Object.assign(new Error('unexpected'), { status: 1 });
      execFileResults.set('find-generic-password', err);
      expect(() => getKey('key')).toThrow('unexpected');
    });

    test('setKey gracefully handles unexpected errors', () => {
      mockPlatform = 'darwin';
      execFileResults.set('add-generic-password', new Error('unexpected'));
      expect(setKey('key', 'val')).toBe(false);
    });
  });
});
