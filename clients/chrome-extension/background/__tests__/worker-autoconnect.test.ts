/**
 * Tests for the worker's auto-connect lifecycle and pause semantics.
 *
 * Coverage:
 *   - User-initiated connect sets autoConnect=true (sticky).
 *   - Pause sets autoConnect=false and tears down the relay.
 *   - Disconnect (backward-compatible alias) behaves identically to pause.
 *   - Bootstrap auto-connects when autoConnect=true, skips when false.
 *   - Failed auto-connect does not flip the extension into a reconnect
 *     loop — it persists an actionable auth error exactly once per
 *     failure chain.
 *   - Reopen behavior after prior successful setup.
 *
 * Since the worker module is side-effectful (registers listeners, calls
 * bootstrap), these tests exercise the key state transitions by
 * replicating the message-handler logic under test in isolation — the
 * same approach used by `worker-connect-preflight.test.ts` and
 * `worker-selected-assistant-connect.test.ts`.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

// ── Fake chrome.storage.local ───────────────────────────────────────

interface FakeStorage {
  data: Record<string, unknown>;
  get(key: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}

function createFakeStorage(): FakeStorage {
  const data: Record<string, unknown> = {};
  return {
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
      Object.assign(data, items);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete data[k];
    },
  };
}

// ── Storage key constants (mirror worker.ts) ────────────────────────

const AUTO_CONNECT_KEY = 'autoConnect';
const RELAY_AUTH_ERROR_KEY = 'vellum.relayAuthError';

// ── Minimal RelayConnection fake ────────────────────────────────────

interface FakeRelayConnection {
  started: boolean;
  closed: boolean;
  closeCode: number | null;
  closeReason: string | null;
  isOpen(): boolean;
  start(): void;
  close(code: number, reason: string): void;
}

function createFakeRelayConnection(opts?: { open?: boolean }): FakeRelayConnection {
  let open = opts?.open ?? false;
  return {
    started: false,
    closed: false,
    closeCode: null,
    closeReason: null,
    isOpen() {
      return open && !this.closed;
    },
    start() {
      this.started = true;
      open = true;
    },
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      open = false;
    },
  };
}

// ── Isolated state machine mirroring worker.ts logic ────────────────
//
// This replicates the state transitions from the worker's message
// listener and bootstrap function so we can test them without loading
// the full side-effectful service worker module.

interface WorkerState {
  shouldConnect: boolean;
  relayConnection: FakeRelayConnection | null;
  currentAuthProfile: 'local-pair' | 'cloud-oauth' | 'unsupported' | null;
  storage: FakeStorage;
}

function createWorkerState(overrides?: Partial<WorkerState>): WorkerState {
  return {
    shouldConnect: false,
    relayConnection: null,
    currentAuthProfile: null,
    storage: createFakeStorage(),
    ...overrides,
  };
}

class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTokenError';
  }
}

interface RelayAuthError {
  message: string;
  mode: 'cloud' | 'self-hosted';
  at: number;
}

/**
 * Simulate the connect message handler's success path.
 * Sets shouldConnect, calls connect (simulated as setting up a relay),
 * and on success persists autoConnect=true.
 */
async function handleConnect(state: WorkerState): Promise<{ ok: boolean; error?: string }> {
  state.shouldConnect = true;
  try {
    // Simulate a successful connect: create and start a relay connection.
    const relay = createFakeRelayConnection();
    relay.start();
    state.relayConnection = relay;
    // Successful user-initiated connect — make auto-connect sticky.
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });
    return { ok: true };
  } catch (err) {
    state.shouldConnect = false;
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Simulate a failed connect attempt (e.g. missing token).
 */
async function handleConnectFailing(
  state: WorkerState,
  error: Error,
): Promise<{ ok: boolean; error?: string }> {
  state.shouldConnect = true;
  // Connect fails
  state.shouldConnect = false;
  const errorMessage = error.message;
  return { ok: false, error: errorMessage };
}

/**
 * Simulate the pause/disconnect message handler.
 * Both `pause` and `disconnect` actions clear autoConnect and tear
 * down the relay.
 */
async function handlePause(state: WorkerState): Promise<{ ok: boolean }> {
  state.shouldConnect = false;
  await state.storage.set({ [AUTO_CONNECT_KEY]: false });
  if (state.relayConnection) {
    state.relayConnection.close(1000, 'User paused');
    state.relayConnection = null;
  }
  return { ok: true };
}

/**
 * Simulate the bootstrap function. Reads autoConnect from storage;
 * when true, attempts a non-interactive connect.
 *
 * @param connectFn - Injectable connect simulation. Returns void on
 *   success, throws on failure.
 */
async function simulateBootstrap(
  state: WorkerState,
  connectFn: () => Promise<void>,
): Promise<void> {
  const result = await state.storage.get(AUTO_CONNECT_KEY);
  if (result[AUTO_CONNECT_KEY] !== true) return;

  state.shouldConnect = true;
  try {
    await connectFn();
  } catch (err) {
    state.shouldConnect = false;
    const detail = err instanceof Error ? err.message : String(err);
    const mode: 'cloud' | 'self-hosted' =
      state.currentAuthProfile === 'cloud-oauth' ? 'cloud' : 'self-hosted';

    // Persist auth error exactly once for popup display.
    await state.storage.set({
      [RELAY_AUTH_ERROR_KEY]: {
        message: detail,
        mode,
        at: Date.now(),
      } satisfies RelayAuthError,
    });
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('autoConnect lifecycle — connect sets sticky flag', () => {
  test('successful user-initiated connect sets autoConnect=true', async () => {
    const state = createWorkerState();

    const response = await handleConnect(state);

    expect(response.ok).toBe(true);
    expect(state.shouldConnect).toBe(true);
    expect(state.relayConnection).not.toBeNull();
    expect(state.relayConnection!.isOpen()).toBe(true);

    const stored = await state.storage.get(AUTO_CONNECT_KEY);
    expect(stored[AUTO_CONNECT_KEY]).toBe(true);
  });

  test('failed connect does not set autoConnect=true', async () => {
    const state = createWorkerState();

    const response = await handleConnectFailing(
      state,
      new MissingTokenError('Sign in with Vellum (cloud) before connecting'),
    );

    expect(response.ok).toBe(false);
    expect(state.shouldConnect).toBe(false);

    const stored = await state.storage.get(AUTO_CONNECT_KEY);
    expect(stored[AUTO_CONNECT_KEY]).toBeUndefined();
  });
});

describe('pause semantics — clears autoConnect and tears down relay', () => {
  test('pause sets autoConnect=false and closes relay', async () => {
    const state = createWorkerState();

    // First connect successfully
    await handleConnect(state);
    expect(state.relayConnection!.isOpen()).toBe(true);

    const preCheck = await state.storage.get(AUTO_CONNECT_KEY);
    expect(preCheck[AUTO_CONNECT_KEY]).toBe(true);

    // Now pause
    const response = await handlePause(state);

    expect(response.ok).toBe(true);
    expect(state.shouldConnect).toBe(false);
    expect(state.relayConnection).toBeNull();

    const postCheck = await state.storage.get(AUTO_CONNECT_KEY);
    expect(postCheck[AUTO_CONNECT_KEY]).toBe(false);
  });

  test('pause is idempotent when already disconnected', async () => {
    const state = createWorkerState();

    // No active connection
    const response = await handlePause(state);

    expect(response.ok).toBe(true);
    expect(state.shouldConnect).toBe(false);

    const stored = await state.storage.get(AUTO_CONNECT_KEY);
    expect(stored[AUTO_CONNECT_KEY]).toBe(false);
  });

  test('disconnect (backward-compatible alias) behaves identically to pause', async () => {
    const state = createWorkerState();

    // Connect first
    await handleConnect(state);

    // "disconnect" performs the same transitions as "pause"
    const response = await handlePause(state); // same handler

    expect(response.ok).toBe(true);
    expect(state.shouldConnect).toBe(false);
    expect(state.relayConnection).toBeNull();

    const stored = await state.storage.get(AUTO_CONNECT_KEY);
    expect(stored[AUTO_CONNECT_KEY]).toBe(false);
  });
});

describe('bootstrap — auto-connect on service worker startup', () => {
  test('bootstrap auto-connects when autoConnect=true', async () => {
    const state = createWorkerState();
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    let connectCalled = false;
    await simulateBootstrap(state, async () => {
      connectCalled = true;
      // Simulate successful connect
      const relay = createFakeRelayConnection();
      relay.start();
      state.relayConnection = relay;
    });

    expect(connectCalled).toBe(true);
    expect(state.shouldConnect).toBe(true);
    expect(state.relayConnection).not.toBeNull();
  });

  test('bootstrap skips when autoConnect=false', async () => {
    const state = createWorkerState();
    await state.storage.set({ [AUTO_CONNECT_KEY]: false });

    let connectCalled = false;
    await simulateBootstrap(state, async () => {
      connectCalled = true;
    });

    expect(connectCalled).toBe(false);
    expect(state.shouldConnect).toBe(false);
  });

  test('bootstrap skips when autoConnect is not set', async () => {
    const state = createWorkerState();
    // Storage is empty — no autoConnect key at all

    let connectCalled = false;
    await simulateBootstrap(state, async () => {
      connectCalled = true;
    });

    expect(connectCalled).toBe(false);
    expect(state.shouldConnect).toBe(false);
  });
});

describe('failed auto-connect — no reconnect loop', () => {
  test('failed auto-connect resets shouldConnect and persists error once', async () => {
    const state = createWorkerState({ currentAuthProfile: 'local-pair' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    const errorMessage = 'Pair the Vellum assistant (self-hosted) before connecting';
    await simulateBootstrap(state, async () => {
      throw new MissingTokenError(errorMessage);
    });

    // shouldConnect must be reset so the worker does not retry
    expect(state.shouldConnect).toBe(false);

    // Auth error should be persisted exactly once for popup display
    const errorResult = await state.storage.get(RELAY_AUTH_ERROR_KEY);
    const persisted = errorResult[RELAY_AUTH_ERROR_KEY] as RelayAuthError;
    expect(persisted).toBeDefined();
    expect(persisted.message).toBe(errorMessage);
    expect(persisted.mode).toBe('self-hosted');
    expect(typeof persisted.at).toBe('number');
  });

  test('failed auto-connect for cloud mode persists cloud error', async () => {
    const state = createWorkerState({ currentAuthProfile: 'cloud-oauth' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    const errorMessage = 'Sign in with Vellum (cloud) before connecting';
    await simulateBootstrap(state, async () => {
      throw new MissingTokenError(errorMessage);
    });

    expect(state.shouldConnect).toBe(false);

    const errorResult = await state.storage.get(RELAY_AUTH_ERROR_KEY);
    const persisted = errorResult[RELAY_AUTH_ERROR_KEY] as RelayAuthError;
    expect(persisted.mode).toBe('cloud');
    expect(persisted.message).toBe(errorMessage);
  });

  test('non-token auto-connect failure also persists error and stops', async () => {
    const state = createWorkerState({ currentAuthProfile: 'local-pair' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    const errorMessage = 'Native host not installed';
    await simulateBootstrap(state, async () => {
      throw new Error(errorMessage);
    });

    expect(state.shouldConnect).toBe(false);

    const errorResult = await state.storage.get(RELAY_AUTH_ERROR_KEY);
    const persisted = errorResult[RELAY_AUTH_ERROR_KEY] as RelayAuthError;
    expect(persisted.message).toBe(errorMessage);
  });
});

describe('reopen behavior — full lifecycle', () => {
  test('connect -> close browser -> reopen resumes auto-connect', async () => {
    const state = createWorkerState();

    // Step 1: User connects successfully
    await handleConnect(state);
    const afterConnect = await state.storage.get(AUTO_CONNECT_KEY);
    expect(afterConnect[AUTO_CONNECT_KEY]).toBe(true);

    // Step 2: Simulate browser close (relay torn down, worker dies).
    // The storage flag survives because chrome.storage.local is
    // persisted across service-worker restarts.

    // Step 3: Simulate reopen — fresh worker state but storage persists
    const freshState = createWorkerState({
      storage: state.storage, // same persistent storage
    });

    let bootstrapConnectCalled = false;
    await simulateBootstrap(freshState, async () => {
      bootstrapConnectCalled = true;
      const relay = createFakeRelayConnection();
      relay.start();
      freshState.relayConnection = relay;
    });

    expect(bootstrapConnectCalled).toBe(true);
    expect(freshState.shouldConnect).toBe(true);
    expect(freshState.relayConnection!.isOpen()).toBe(true);
  });

  test('connect -> pause -> close browser -> reopen does NOT auto-connect', async () => {
    const state = createWorkerState();

    // Step 1: User connects
    await handleConnect(state);
    // Step 2: User pauses
    await handlePause(state);

    const afterPause = await state.storage.get(AUTO_CONNECT_KEY);
    expect(afterPause[AUTO_CONNECT_KEY]).toBe(false);

    // Step 3: Simulate reopen — fresh worker state, same storage
    const freshState = createWorkerState({
      storage: state.storage,
    });

    let bootstrapConnectCalled = false;
    await simulateBootstrap(freshState, async () => {
      bootstrapConnectCalled = true;
    });

    expect(bootstrapConnectCalled).toBe(false);
    expect(freshState.shouldConnect).toBe(false);
    expect(freshState.relayConnection).toBeNull();
  });

  test('connect -> pause -> reconnect -> reopen resumes auto-connect', async () => {
    const state = createWorkerState();

    // Step 1: Connect
    await handleConnect(state);
    // Step 2: Pause
    await handlePause(state);
    // Step 3: Reconnect
    await handleConnect(state);

    const afterReconnect = await state.storage.get(AUTO_CONNECT_KEY);
    expect(afterReconnect[AUTO_CONNECT_KEY]).toBe(true);

    // Step 4: Simulate reopen
    const freshState = createWorkerState({
      storage: state.storage,
    });

    let bootstrapConnectCalled = false;
    await simulateBootstrap(freshState, async () => {
      bootstrapConnectCalled = true;
      const relay = createFakeRelayConnection();
      relay.start();
      freshState.relayConnection = relay;
    });

    expect(bootstrapConnectCalled).toBe(true);
    expect(freshState.shouldConnect).toBe(true);
  });
});
