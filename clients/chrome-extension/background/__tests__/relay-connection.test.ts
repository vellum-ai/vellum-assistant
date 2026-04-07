/**
 * Tests for the RelayConnection helper.
 *
 * Drives the class against a fake global WebSocket so we can exercise
 * the open/message/close/reconnect lifecycle without touching a real
 * socket. Covers both self-hosted and cloud modes and the caller-close
 * vs unexpected-close branches.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { RelayConnection, type RelayMode } from '../relay-connection.js';

// ── Fake WebSocket ──────────────────────────────────────────────────

type WsListener = (ev: { data?: unknown; code?: number; reason?: string }) => void;

interface FakeWebSocket {
  url: string;
  readyState: number;
  listeners: Map<string, Set<WsListener>>;
  sent: string[];
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  addEventListener: (type: string, listener: WsListener) => void;
  removeEventListener: (type: string, listener: WsListener) => void;
  dispatch: (type: string, ev: { data?: unknown; code?: number; reason?: string }) => void;
  /** Track whether close() was called by the helper (caller-side) */
  closeCallsByCaller: Array<{ code?: number; reason?: string }>;
}

let instances: FakeWebSocket[] = [];

function makeFakeWebSocket(url: string): FakeWebSocket {
  const listeners = new Map<string, Set<WsListener>>();
  const sent: string[] = [];
  const closeCallsByCaller: Array<{ code?: number; reason?: string }> = [];
  const ws: FakeWebSocket = {
    url,
    readyState: 0, // CONNECTING
    listeners,
    sent,
    closeCallsByCaller,
    close(code, reason) {
      closeCallsByCaller.push({ code, reason });
      ws.readyState = 3; // CLOSED
    },
    send(data) {
      sent.push(data);
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, ev) {
      const set = listeners.get(type);
      if (!set) return;
      for (const l of set) l(ev);
    },
  };
  return ws;
}

// Mimic the WebSocket.OPEN etc. static constants used by the class.
function installFakeWebSocket(): void {
  instances = [];
  const FakeCtor = function (this: unknown, url: string) {
    const instance = makeFakeWebSocket(url);
    instances.push(instance);
    return instance as unknown as WebSocket;
  } as unknown as typeof WebSocket;
  (FakeCtor as unknown as { CONNECTING: number }).CONNECTING = 0;
  (FakeCtor as unknown as { OPEN: number }).OPEN = 1;
  (FakeCtor as unknown as { CLOSING: number }).CLOSING = 2;
  (FakeCtor as unknown as { CLOSED: number }).CLOSED = 3;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = FakeCtor;
}

const originalWebSocket = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;

beforeEach(() => {
  installFakeWebSocket();
});

afterEach(() => {
  (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket = originalWebSocket;
});

/** Walk the fake-ws instance into the OPEN state and fire the open event. */
function openSocket(ws: FakeWebSocket): void {
  ws.readyState = 1;
  ws.dispatch('open', {});
}

/** Fire a close event as if the server kicked us. */
function closeSocket(ws: FakeWebSocket, code = 1006, reason = 'abnormal'): void {
  ws.readyState = 3;
  ws.dispatch('close', { code, reason });
}

// ── Harness ─────────────────────────────────────────────────────────

interface Callbacks {
  openCalls: number;
  closeCalls: Array<{ code: number; reason: string }>;
  messages: string[];
}

function makeCallbacks(): Callbacks {
  return { openCalls: 0, closeCalls: [], messages: [] };
}

function makeConn(mode: RelayMode, callbacks: Callbacks, onReconnect?: () => Promise<string | null | void>): RelayConnection {
  return new RelayConnection({
    mode,
    onOpen: () => {
      callbacks.openCalls += 1;
    },
    onMessage: (data) => {
      callbacks.messages.push(data);
    },
    onClose: (code, reason) => {
      callbacks.closeCalls.push({ code, reason });
    },
    onReconnect,
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('RelayConnection', () => {
  describe('start', () => {
    test('opens a self-hosted WebSocket to the expected URL', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        {
          kind: 'self-hosted',
          baseUrl: 'http://127.0.0.1:7830',
          token: 'local-token-abc',
        },
        cbs,
      );

      conn.start();

      expect(instances.length).toBe(1);
      expect(instances[0].url).toBe(
        'ws://127.0.0.1:7830/v1/browser-relay?token=local-token-abc',
      );

      openSocket(instances[0]);
      expect(cbs.openCalls).toBe(1);
      expect(conn.isOpen()).toBe(true);
    });

    test('opens a cloud WebSocket to the expected wss URL', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        {
          kind: 'cloud',
          baseUrl: 'https://api.vellum.ai',
          token: 'cloud-jwt-xyz',
        },
        cbs,
      );

      conn.start();

      expect(instances.length).toBe(1);
      expect(instances[0].url).toBe(
        'wss://api.vellum.ai/v1/browser-relay?token=cloud-jwt-xyz',
      );
    });

    test('URL-encodes special characters in the token', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        {
          kind: 'cloud',
          baseUrl: 'https://api.vellum.ai/',
          token: 'a b+c/d=',
        },
        cbs,
      );

      conn.start();

      expect(instances.length).toBe(1);
      expect(instances[0].url).toBe(
        'wss://api.vellum.ai/v1/browser-relay?token=a%20b%2Bc%2Fd%3D',
      );
    });

    test('strips a trailing slash on the base URL', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        {
          kind: 'cloud',
          baseUrl: 'https://api.vellum.ai/',
          token: 'tok',
        },
        cbs,
      );

      conn.start();

      expect(instances[0].url).not.toContain('ai//');
      expect(instances[0].url).toBe('wss://api.vellum.ai/v1/browser-relay?token=tok');
    });

    test('omits the token query param when the caller passes null', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        {
          kind: 'self-hosted',
          baseUrl: 'http://127.0.0.1:7830',
          token: null,
        },
        cbs,
      );

      conn.start();

      expect(instances[0].url).toBe('ws://127.0.0.1:7830/v1/browser-relay');
    });
  });

  describe('onMessage', () => {
    test('forwards incoming messages to the caller', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      instances[0].dispatch('message', { data: 'hello-from-daemon' });
      instances[0].dispatch('message', { data: 'second' });

      expect(cbs.messages).toEqual(['hello-from-daemon', 'second']);
    });

    test('stringifies non-string event data (belt-and-suspenders)', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      // Simulate a binary frame that arrived as a Blob-like object; the
      // class uses String(ev.data) to keep the callback signature simple.
      instances[0].dispatch('message', { data: 42 });

      expect(cbs.messages).toEqual(['42']);
    });
  });

  describe('close', () => {
    test('caller-close prevents reconnect on a subsequent unexpected close', async () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      expect(instances.length).toBe(1);

      conn.close();
      // close() synchronously calls the underlying ws.close — the fake
      // dispatches the close event manually only on explicit dispatch.
      closeSocket(instances[0], 1000, 'caller closed');

      // Wait a tick to be sure any stray setTimeout didn't enqueue a
      // reconnect.
      await new Promise((r) => setTimeout(r, 5));
      expect(instances.length).toBe(1);
    });

    test('marks closedByCaller so isOpen returns false', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      expect(conn.isOpen()).toBe(true);
      conn.close();
      expect(conn.isOpen()).toBe(false);
    });

    test('close with code 1000 on the helper forwards to the socket', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      conn.close(1000, 'bye');

      expect(instances[0].closeCallsByCaller.length).toBe(1);
      expect(instances[0].closeCallsByCaller[0].code).toBe(1000);
      expect(instances[0].closeCallsByCaller[0].reason).toBe('bye');
    });
  });

  describe('reconnect', () => {
    test('unexpected close triggers reconnect after a delay', async () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      expect(instances.length).toBe(1);

      // Server-side abnormal close (e.g. the daemon restarted).
      closeSocket(instances[0], 1006, 'abnormal');

      expect(cbs.closeCalls.length).toBe(1);
      expect(cbs.closeCalls[0].code).toBe(1006);

      // The reconnect is scheduled behind a real setTimeout — wait long
      // enough for it to fire. The base delay is 1000ms; we tolerate
      // some scheduling jitter.
      await new Promise((r) => setTimeout(r, 1100));

      expect(instances.length).toBe(2);
      expect(instances[1].url).toBe(
        'ws://127.0.0.1:7830/v1/browser-relay?token=t',
      );

      // Clean up.
      conn.close();
    });

    test('normal close (code 1000) does NOT call onReconnect', async () => {
      const cbs = makeCallbacks();
      let reconnectCalls = 0;
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
        async () => {
          reconnectCalls += 1;
          return 'new-token';
        },
      );

      conn.start();
      openSocket(instances[0]);

      // Normal close — should still schedule a reconnect but without
      // calling the refresh hook.
      closeSocket(instances[0], 1000, 'normal');
      await new Promise((r) => setTimeout(r, 1100));

      expect(reconnectCalls).toBe(0);
      expect(instances.length).toBe(2);

      conn.close();
    });

    test('onReconnect replaces the token used for the next URL', async () => {
      const cbs = makeCallbacks();
      let refreshCalls = 0;
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 'old' },
        cbs,
        async () => {
          refreshCalls += 1;
          return 'fresh-token';
        },
      );

      conn.start();
      openSocket(instances[0]);
      expect(instances[0].url).toContain('token=old');

      closeSocket(instances[0], 4001, 'auth rotated');
      await new Promise((r) => setTimeout(r, 1100));

      expect(refreshCalls).toBe(1);
      expect(instances.length).toBe(2);
      expect(instances[1].url).toContain('token=fresh-token');

      conn.close();
    });

    test('onReconnect returning void leaves the existing token in place', async () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 'keep' },
        cbs,
        async () => {
          // no return → void
        },
      );

      conn.start();
      openSocket(instances[0]);
      closeSocket(instances[0], 1006, 'abnormal');
      await new Promise((r) => setTimeout(r, 1100));

      expect(instances.length).toBe(2);
      expect(instances[1].url).toContain('token=keep');

      conn.close();
    });

    test('close called before scheduled reconnect fires prevents reconnection', async () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      closeSocket(instances[0], 1006, 'abnormal');

      // Cancel before the reconnect timer fires.
      conn.close();

      await new Promise((r) => setTimeout(r, 1100));

      // No second socket should have been constructed.
      expect(instances.length).toBe(1);
    });
  });

  describe('setMode', () => {
    test('closes the current socket and opens a new one for the new mode', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      expect(instances.length).toBe(1);
      expect(instances[0].url).toContain('ws://127.0.0.1');

      conn.setMode({ kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'cloud-jwt' });

      // Old socket was closed by the caller; new one was constructed
      // against the cloud URL.
      expect(instances[0].closeCallsByCaller.length).toBe(1);
      expect(instances.length).toBe(2);
      expect(instances[1].url).toBe(
        'wss://api.vellum.ai/v1/browser-relay?token=cloud-jwt',
      );

      conn.close();
    });

    test('updates the mode getter', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );
      conn.start();
      expect(conn.mode.kind).toBe('self-hosted');

      conn.setMode({ kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'c' });
      expect(conn.mode.kind).toBe('cloud');

      conn.close();
    });
  });

  describe('send', () => {
    test('writes to the underlying socket when OPEN', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      conn.send('hello-daemon');

      expect(instances[0].sent).toEqual(['hello-daemon']);
    });

    test('is a no-op before the socket is OPEN', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      // ws.readyState is still CONNECTING (0).
      conn.send('too-early');
      expect(instances[0].sent).toEqual([]);
    });
  });
});
