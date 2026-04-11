/**
 * Tests for the self-hosted capability-token bootstrap state machine.
 *
 * These tests mock `chrome.runtime.connectNative` and `chrome.storage.local`
 * so they can run under bun:test without a real Chrome runtime. The fake
 * native-messaging port is a tiny event emitter that lets the test drive
 * `onMessage` / `onDisconnect` callbacks by hand.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  getStoredLocalToken,
  clearLocalToken,
  bootstrapLocalToken,
  localTokenStorageKey,
  type StoredLocalToken,
} from '../self-hosted-auth.js';

const ASSISTANT_A = 'assistant-alpha';
const ASSISTANT_B = 'assistant-beta';

interface FakeStorage {
  data: Record<string, unknown>;
  /**
   * When set, the next `set()` call rejects with this error (then the
   * override is cleared). Used to exercise the storage-failure path.
   */
  nextSetError?: Error;
  get(key: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}

function createFakeStorage(): FakeStorage {
  const data: Record<string, unknown> = {};
  const storage: FakeStorage = {
    data,
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in data) result[k] = data[k];
      }
      return result;
    },
    async set(items) {
      if (storage.nextSetError) {
        const err = storage.nextSetError;
        storage.nextSetError = undefined;
        throw err;
      }
      Object.assign(data, items);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete data[k];
    },
  };
  return storage;
}

interface FakePort {
  name: string;
  onMessage: {
    addListener(listener: (msg: unknown) => void): void;
    removeListener(listener: (msg: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: (port: FakePort) => void): void;
    removeListener(listener: (port: FakePort) => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;

  // Test handles
  sent: unknown[];
  disconnected: boolean;
  emitMessage(msg: unknown): void;
  emitDisconnect(): void;
}

interface FakeNativeRuntime {
  lastError: { message?: string } | undefined;
  connectNative(name: string): FakePort;
  /** Set by the test to control how newly-created ports behave. */
  onConnect?: (port: FakePort, application: string) => void;
  /** The most recently created port, for convenience in tests. */
  currentPort?: FakePort;
  /** Log of application names passed to connectNative. */
  connectCalls: string[];
}

function createFakePort(): FakePort {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<(port: FakePort) => void> = [];
  const port: FakePort = {
    name: 'com.vellum.daemon',
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      },
      removeListener(listener) {
        const idx = messageListeners.indexOf(listener);
        if (idx >= 0) messageListeners.splice(idx, 1);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
      removeListener(listener) {
        const idx = disconnectListeners.indexOf(listener);
        if (idx >= 0) disconnectListeners.splice(idx, 1);
      },
    },
    postMessage(message) {
      port.sent.push(message);
    },
    disconnect() {
      port.disconnected = true;
    },
    sent: [],
    disconnected: false,
    emitMessage(msg) {
      for (const listener of messageListeners.slice()) listener(msg);
    },
    emitDisconnect() {
      for (const listener of disconnectListeners.slice()) listener(port);
    },
  };
  return port;
}

function createFakeRuntime(): FakeNativeRuntime {
  const runtime: FakeNativeRuntime = {
    lastError: undefined,
    connectCalls: [],
    connectNative(application: string) {
      runtime.connectCalls.push(application);
      const port = createFakePort();
      runtime.currentPort = port;
      if (runtime.onConnect) runtime.onConnect(port, application);
      return port;
    },
  };
  return runtime;
}

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

let fakeStorage: FakeStorage;
let fakeRuntime: FakeNativeRuntime;

beforeEach(() => {
  fakeStorage = createFakeStorage();
  fakeRuntime = createFakeRuntime();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: fakeStorage,
    },
    runtime: fakeRuntime,
  };
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe('localTokenStorageKey', () => {
  test('builds a colon-separated key', () => {
    expect(localTokenStorageKey('my-assistant')).toBe(
      'vellum.localCapabilityToken:my-assistant',
    );
  });
});

describe('bootstrapLocalToken', () => {
  test('happy path persists and returns the token', async () => {
    const issuedAt = Date.now();
    const expiresAtIso = new Date(issuedAt + 3_600_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      // Drive the response asynchronously to mirror how Chrome delivers
      // native-messaging frames in practice.
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'abc123',
          expiresAt: expiresAtIso,
          guardianId: 'g-42',
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.token).toBe('abc123');
    expect(result.guardianId).toBe('g-42');
    expect(result.expiresAt).toBe(Date.parse(expiresAtIso));

    // Port was told to request a token.
    expect(fakeRuntime.connectCalls).toEqual(['com.vellum.daemon']);
    expect(fakeRuntime.currentPort?.sent).toEqual([{ type: 'request_token' }]);

    // Token was persisted under assistant-scoped key.
    const key = localTokenStorageKey(ASSISTANT_A);
    expect(fakeStorage.data[key]).toEqual(result);

    // Port was cleaned up.
    expect(fakeRuntime.currentPort?.disconnected).toBe(true);
  });

  test('accepts numeric expiresAt for forward compatibility', async () => {
    const expiresAt = Date.now() + 60_000;

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'num-token',
          expiresAt,
          guardianId: 'g-1',
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.expiresAt).toBe(expiresAt);
  });

  test('persists assistantPort when the helper frame includes it', async () => {
    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'cap-token',
          expiresAt: expiresAtIso,
          guardianId: 'g-port',
          assistantPort: 7821,
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.assistantPort).toBe(7821);
    expect(result.guardianId).toBe('g-port');

    // And the stored value must round-trip through getStoredLocalToken.
    const loaded = await getStoredLocalToken(ASSISTANT_A);
    expect(loaded).not.toBeNull();
    expect(loaded!.assistantPort).toBe(7821);
  });

  test('omits assistantPort when the helper frame is missing it', async () => {
    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'legacy-cap-token',
          expiresAt: expiresAtIso,
          guardianId: 'g-legacy',
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.assistantPort).toBeUndefined();
    expect(result.guardianId).toBe('g-legacy');
  });

  test('drops malformed assistantPort from the helper frame', async () => {
    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'malformed-port-token',
          expiresAt: expiresAtIso,
          guardianId: 'g-malformed',
          // 99999 is out of the valid port range
          assistantPort: 99999,
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.assistantPort).toBeUndefined();
  });

  test('malformed token_response rejects and does not persist', async () => {
    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'abc',
          // Missing expiresAt
          guardianId: 'g-1',
        });
      });
    };

    await expect(bootstrapLocalToken(ASSISTANT_A)).rejects.toThrow('malformed token_response');
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
    expect(fakeRuntime.currentPort?.disconnected).toBe(true);
  });

  test('error frame rejects with the helper message', async () => {
    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({ type: 'error', message: 'unauthorized_origin' });
      });
    };

    await expect(bootstrapLocalToken(ASSISTANT_A)).rejects.toThrow('unauthorized_origin');
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
    expect(fakeRuntime.currentPort?.disconnected).toBe(true);
  });

  test('error frame without message falls back to a default', async () => {
    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({ type: 'error' });
      });
    };

    await expect(bootstrapLocalToken(ASSISTANT_A)).rejects.toThrow('native messaging error');
  });

  test('timeout rejects and disconnects the port', async () => {
    // onConnect is a no-op — the helper never responds.
    fakeRuntime.onConnect = () => {
      // Intentionally silent.
    };

    await expect(bootstrapLocalToken(ASSISTANT_A, { timeoutMs: 20 })).rejects.toThrow(
      'native messaging timeout',
    );
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
    expect(fakeRuntime.currentPort?.disconnected).toBe(true);
  });

  test('disconnect before response rejects with lastError message', async () => {
    fakeRuntime.lastError = { message: 'Specified native messaging host not found.' };
    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitDisconnect();
      });
    };

    await expect(bootstrapLocalToken(ASSISTANT_A)).rejects.toThrow(
      'Specified native messaging host not found.',
    );
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });

  test('disconnect with no lastError falls back to generic message', async () => {
    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitDisconnect();
      });
    };

    await expect(bootstrapLocalToken(ASSISTANT_A)).rejects.toThrow(
      'native messaging disconnected before response',
    );
  });

  test('resolves with the in-memory token when chrome.storage.local.set fails', async () => {
    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();
    fakeStorage.nextSetError = new Error('QuotaExceededError');

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'persist-fail',
          expiresAt: expiresAtIso,
          guardianId: 'g-persist',
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.token).toBe('persist-fail');
    expect(result.guardianId).toBe('g-persist');
    expect(result.expiresAt).toBe(Date.parse(expiresAtIso));

    // But nothing was actually written to storage.
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();

    // And the port was torn down as part of marking the promise settled.
    expect(fakeRuntime.currentPort?.disconnected).toBe(true);
  });

  test('ignores onDisconnect after a valid token_response (race)', async () => {
    fakeRuntime.lastError = { message: 'port closed' };

    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'race-winner',
          expiresAt: expiresAtIso,
          guardianId: 'g-race',
        });
        port.emitDisconnect();
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.token).toBe('race-winner');
    expect(result.guardianId).toBe('g-race');
    // Token was still persisted despite the racing disconnect.
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toEqual(result);
  });

  test('ignores unknown frame types until a recognised frame arrives', async () => {
    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({ type: 'some_future_type', payload: {} });
        port.emitMessage(null);
        port.emitMessage('not-an-object');
        port.emitMessage({
          type: 'token_response',
          token: 'late',
          expiresAt: expiresAtIso,
          guardianId: 'g-late',
        });
      });
    };

    const result = await bootstrapLocalToken(ASSISTANT_A);
    expect(result.token).toBe('late');
  });
});

describe('getStoredLocalToken', () => {
  test('returns null when nothing is stored', async () => {
    expect(await getStoredLocalToken(ASSISTANT_A)).toBeNull();
  });

  test('returns the stored token when valid', async () => {
    const token: StoredLocalToken = {
      token: 'valid',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-1',
    };
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = token;
    expect(await getStoredLocalToken(ASSISTANT_A)).toEqual(token);
  });

  test('returns null when the token is expired', async () => {
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = {
      token: 'expired',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-1',
    } satisfies StoredLocalToken;
    expect(await getStoredLocalToken(ASSISTANT_A)).toBeNull();
  });

  test('returns null when the stored value is malformed', async () => {
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = { token: 42, expiresAt: 'soon' };
    expect(await getStoredLocalToken(ASSISTANT_A)).toBeNull();
  });

  test('returns null when guardianId is missing', async () => {
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = {
      token: 'valid',
      expiresAt: Date.now() + 60_000,
    };
    expect(await getStoredLocalToken(ASSISTANT_A)).toBeNull();
  });

  test('returns the stored token including assistantPort when present', async () => {
    const token: StoredLocalToken = {
      token: 'with-port',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-port',
      assistantPort: 7821,
    };
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = token;
    const loaded = await getStoredLocalToken(ASSISTANT_A);
    expect(loaded?.assistantPort).toBe(7821);
  });

  test('strips a malformed assistantPort rather than rejecting the token', async () => {
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = {
      token: 'bad-port',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-bad',
      assistantPort: -1,
    };
    const loaded = await getStoredLocalToken(ASSISTANT_A);
    // Token still loads, but the bogus port was dropped.
    expect(loaded).not.toBeNull();
    expect(loaded?.token).toBe('bad-port');
    expect(loaded?.assistantPort).toBeUndefined();
  });
});

describe('clearLocalToken', () => {
  test('removes the key from storage', async () => {
    const key = localTokenStorageKey(ASSISTANT_A);
    fakeStorage.data[key] = {
      token: 'to-clear',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-1',
    } satisfies StoredLocalToken;
    await clearLocalToken(ASSISTANT_A);
    expect(fakeStorage.data[key]).toBeUndefined();
  });

  test('is a no-op when nothing is stored', async () => {
    await clearLocalToken(ASSISTANT_A);
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });
});

describe('assistant token isolation', () => {
  test('tokens stored for different assistants do not interfere', async () => {
    const tokenA: StoredLocalToken = {
      token: 'token-for-alpha',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-alpha',
    };
    const tokenB: StoredLocalToken = {
      token: 'token-for-beta',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-beta',
    };
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = tokenA;
    fakeStorage.data[localTokenStorageKey(ASSISTANT_B)] = tokenB;

    const loadedA = await getStoredLocalToken(ASSISTANT_A);
    const loadedB = await getStoredLocalToken(ASSISTANT_B);

    expect(loadedA?.token).toBe('token-for-alpha');
    expect(loadedB?.token).toBe('token-for-beta');
  });

  test('clearing one assistant token does not affect another', async () => {
    const tokenA: StoredLocalToken = {
      token: 'alpha-token',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-alpha',
    };
    const tokenB: StoredLocalToken = {
      token: 'beta-token',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-beta',
    };
    fakeStorage.data[localTokenStorageKey(ASSISTANT_A)] = tokenA;
    fakeStorage.data[localTokenStorageKey(ASSISTANT_B)] = tokenB;

    await clearLocalToken(ASSISTANT_A);

    expect(await getStoredLocalToken(ASSISTANT_A)).toBeNull();
    expect(await getStoredLocalToken(ASSISTANT_B)).toEqual(tokenB);
  });

  test('bootstrap persists under the correct assistant-scoped key', async () => {
    const expiresAtIso = new Date(Date.now() + 60_000).toISOString();

    fakeRuntime.onConnect = (port) => {
      queueMicrotask(() => {
        port.emitMessage({
          type: 'token_response',
          token: 'scoped-token',
          expiresAt: expiresAtIso,
          guardianId: 'g-scoped',
        });
      });
    };

    await bootstrapLocalToken(ASSISTANT_B);

    // Only ASSISTANT_B's key should be populated.
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_B)]).toBeDefined();
    expect(fakeStorage.data[localTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });
});
