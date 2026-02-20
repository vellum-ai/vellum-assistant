import { describe, test, expect, afterEach } from 'bun:test';
import {
  registerPendingCallback,
  consumeCallback,
  consumeCallbackError,
  clearAllCallbacks,
} from '../security/oauth-callback-registry.js';

afterEach(() => {
  clearAllCallbacks();
});

describe('OAuth callback registry', () => {
  test('registerPendingCallback + consumeCallback resolves with code', async () => {
    const promise = new Promise<string>((resolve, reject) => {
      registerPendingCallback('state-1', resolve, reject);
    });

    const consumed = consumeCallback('state-1', 'auth-code-123');
    expect(consumed).toBe(true);

    const code = await promise;
    expect(code).toBe('auth-code-123');
  });

  test('consumeCallback with unknown state returns false', () => {
    const consumed = consumeCallback('nonexistent', 'code');
    expect(consumed).toBe(false);
  });

  test('consumeCallbackError rejects the pending callback', async () => {
    const promise = new Promise<string>((resolve, reject) => {
      registerPendingCallback('state-err', resolve, reject);
    });

    const consumed = consumeCallbackError('state-err', 'access_denied');
    expect(consumed).toBe(true);

    await expect(promise).rejects.toThrow('access_denied');
  });

  test('consumeCallbackError with unknown state returns false', () => {
    const consumed = consumeCallbackError('nonexistent', 'some error');
    expect(consumed).toBe(false);
  });

  test('duplicate consumeCallback returns false on second call', async () => {
    const promise = new Promise<string>((resolve, reject) => {
      registerPendingCallback('state-dup', resolve, reject);
    });

    const first = consumeCallback('state-dup', 'code-1');
    expect(first).toBe(true);

    const second = consumeCallback('state-dup', 'code-2');
    expect(second).toBe(false);

    const code = await promise;
    expect(code).toBe('code-1');
  });

  test('TTL expiry rejects callback with timeout error', async () => {
    const promise = new Promise<string>((resolve, reject) => {
      registerPendingCallback('state-ttl', resolve, reject, 50);
    });

    // Wait for the TTL to expire
    await new Promise((r) => setTimeout(r, 100));

    await expect(promise).rejects.toThrow('OAuth callback timed out');

    // After expiry, consume should return false
    const consumed = consumeCallback('state-ttl', 'late-code');
    expect(consumed).toBe(false);
  });

  test('clearAllCallbacks cleans up all pending entries', () => {
    registerPendingCallback('s1', () => {}, () => {});
    registerPendingCallback('s2', () => {}, () => {});
    clearAllCallbacks();

    expect(consumeCallback('s1', 'code')).toBe(false);
    expect(consumeCallback('s2', 'code')).toBe(false);
  });
});
