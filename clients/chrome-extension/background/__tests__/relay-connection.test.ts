/**
 * Tests for the RelayConnection helper.
 *
 * Drives the class against a fake global WebSocket so we can exercise
 * the open/message/close/reconnect lifecycle without touching a real
 * socket. Covers both self-hosted and cloud modes and the caller-close
 * vs unexpected-close branches.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  RelayConnection,
  type RelayMode,
  type RelayReconnectContext,
  type RelayReconnectDecision,
} from '../relay-connection.js';

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
  closeCalls: Array<{ code: number; reason: string; authError?: string }>;
  messages: string[];
}

function makeCallbacks(): Callbacks {
  return { openCalls: 0, closeCalls: [], messages: [] };
}

type ReconnectHook = (
  ctx: RelayReconnectContext,
) => Promise<string | null | void | RelayReconnectDecision>;

function makeConn(
  mode: RelayMode,
  callbacks: Callbacks,
  onReconnect?: ReconnectHook,
): RelayConnection {
  return new RelayConnection({
    mode,
    onOpen: () => {
      callbacks.openCalls += 1;
    },
    onMessage: (data) => {
      callbacks.messages.push(data);
    },
    onClose: (code, reason, authError) => {
      callbacks.closeCalls.push({ code, reason, authError });
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

    test('self-hosted mode carries a capability token opaquely on the URL', () => {
      // PR 3 of the browser-use remediation plan switches the
      // self-hosted transport to present the capability token minted
      // by the native-messaging pair flow as the WebSocket handshake
      // bearer, in place of the gateway-minted JWT. The
      // RelayConnection is transport-agnostic — it only has to
      // URL-encode and forward whatever token string it receives.
      // This test pins that invariant so a future refactor can't
      // accidentally reintroduce JWT-specific parsing.
      const cbs = makeCallbacks();
      const conn = makeConn(
        {
          kind: 'self-hosted',
          baseUrl: 'http://127.0.0.1:7821',
          // Shaped like a real capability token: base64url payload +
          // `.` + base64url signature.
          token: 'eyJjYXAiOiJob3N0X2Jyb3dzZXJfY29tbWFuZCJ9.c29tZS1zaWc',
        },
        cbs,
      );

      conn.start();

      expect(instances[0].url).toBe(
        'ws://127.0.0.1:7821/v1/browser-relay?token=eyJjYXAiOiJob3N0X2Jyb3dzZXJfY29tbWFuZCJ9.c29tZS1zaWc',
      );

      conn.close();
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

    test('cloud reconnect: token refresh replaces URL token on next connect', async () => {
      const cbs = makeCallbacks();
      let seenCtx: RelayReconnectContext | null = null;
      const conn = makeConn(
        { kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'old-jwt' },
        cbs,
        async (ctx) => {
          seenCtx = ctx;
          // New-style return: explicit refreshed decision. Mimics
          // the cloudReconnectHook in worker.ts.
          return { kind: 'refreshed', token: 'fresh-jwt' } satisfies RelayReconnectDecision;
        },
      );

      conn.start();
      openSocket(instances[0]);
      expect(instances[0].url).toBe(
        'wss://api.vellum.ai/v1/browser-relay?token=old-jwt',
      );

      // Simulate the gateway rejecting the JWT with 4001.
      closeSocket(instances[0], 4001, 'token expired');
      await new Promise((r) => setTimeout(r, 1100));

      expect(seenCtx).not.toBeNull();
      expect(seenCtx!.code).toBe(4001);
      expect(seenCtx!.reason).toBe('token expired');

      expect(instances.length).toBe(2);
      expect(instances[1].url).toBe(
        'wss://api.vellum.ai/v1/browser-relay?token=fresh-jwt',
      );

      conn.close();
    });

    test('cloud reconnect: getCurrentMode reflects the refreshed token after reconnect', async () => {
      // The worker relies on getCurrentMode() to pick up the freshly
      // minted token for subsequent host_browser_result POSTs. This
      // pins the invariant that a reconnect-with-refresh cycle swaps
      // the mode's token in place so callers don't need to capture
      // snapshots themselves.
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'old-jwt' },
        cbs,
        async () => ({ kind: 'refreshed', token: 'fresh-jwt' }),
      );

      conn.start();
      openSocket(instances[0]);
      expect(conn.getCurrentMode().token).toBe('old-jwt');

      closeSocket(instances[0], 4001, 'auth');
      await new Promise((r) => setTimeout(r, 1100));

      // Mode accessor returns the refreshed token for any future
      // dispatch reading through it.
      expect(conn.getCurrentMode().kind).toBe('cloud');
      expect(conn.getCurrentMode().token).toBe('fresh-jwt');

      conn.close();
    });

    test('cloud reconnect: abort decision halts reconnect and propagates auth error', async () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'old-jwt' },
        cbs,
        async () => ({
          kind: 'abort',
          error: 'Cloud token expired — sign in again.',
        }),
      );

      conn.start();
      openSocket(instances[0]);
      closeSocket(instances[0], 4001, 'token expired');

      // Wait long enough for the reconnect timer to fire.
      await new Promise((r) => setTimeout(r, 1100));

      // No second socket should have been constructed — the abort
      // decision must stop the reconnect loop cold.
      expect(instances.length).toBe(1);

      // The helper surfaced the auth error via onClose with the
      // original close code + reason so the worker can route it to
      // the popup without a second close event.
      const authCloses = cbs.closeCalls.filter((c) => c.authError !== undefined);
      expect(authCloses.length).toBe(1);
      expect(authCloses[0].code).toBe(4001);
      expect(authCloses[0].reason).toBe('token expired');
      expect(authCloses[0].authError).toBe('Cloud token expired — sign in again.');

      // isOpen must return false and a subsequent unexpected close
      // event must not restart reconnects — the helper is marked as
      // closed by the caller.
      expect(conn.isOpen()).toBe(false);
      await new Promise((r) => setTimeout(r, 1100));
      expect(instances.length).toBe(1);
    });

    test('cloud reconnect: keep decision reuses the existing token', async () => {
      const cbs = makeCallbacks();
      let refreshCalls = 0;
      const conn = makeConn(
        { kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'still-good' },
        cbs,
        async () => {
          refreshCalls += 1;
          return { kind: 'keep' };
        },
      );

      conn.start();
      openSocket(instances[0]);
      // A transient 1006 (abnormal close) shouldn't force a refresh.
      closeSocket(instances[0], 1006, 'network blip');
      await new Promise((r) => setTimeout(r, 1100));

      expect(refreshCalls).toBe(1);
      expect(instances.length).toBe(2);
      expect(instances[1].url).toContain('token=still-good');

      conn.close();
    });

    test('reconnect hook receives the close code and reason as context', async () => {
      const cbs = makeCallbacks();
      const seen: RelayReconnectContext[] = [];
      const conn = makeConn(
        { kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 't' },
        cbs,
        async (ctx) => {
          seen.push(ctx);
          return { kind: 'refreshed', token: 't2' };
        },
      );

      conn.start();
      openSocket(instances[0]);
      closeSocket(instances[0], 4003, 'guardian revoked');
      await new Promise((r) => setTimeout(r, 1100));

      expect(seen.length).toBe(1);
      expect(seen[0].code).toBe(4003);
      expect(seen[0].reason).toBe('guardian revoked');

      conn.close();
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

    test('updates the mode accessor', () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );
      conn.start();
      expect(conn.getCurrentMode().kind).toBe('self-hosted');

      conn.setMode({ kind: 'cloud', baseUrl: 'https://api.vellum.ai', token: 'c' });
      expect(conn.getCurrentMode().kind).toBe('cloud');

      conn.close();
    });

    test('stale close event from a superseded socket does not clear the new ws or schedule reconnect', async () => {
      const cbs = makeCallbacks();
      const conn = makeConn(
        { kind: 'self-hosted', baseUrl: 'http://127.0.0.1:7830', token: 't' },
        cbs,
      );

      conn.start();
      openSocket(instances[0]);
      expect(instances.length).toBe(1);
      const oldSocket = instances[0];

      // Switch modes mid-flight: the helper closes socket A (oldSocket)
      // and constructs socket B (newSocket) for the cloud gateway. We
      // keep newSocket in CONNECTING so we can observe the state that
      // would be disturbed by a stale close event.
      conn.setMode({
        kind: 'cloud',
        baseUrl: 'https://api.vellum.ai',
        token: 'cloud-jwt',
      });
      expect(instances.length).toBe(2);
      const newSocket = instances[1];
      expect(newSocket.url).toBe(
        'wss://api.vellum.ai/v1/browser-relay?token=cloud-jwt',
      );
      expect(conn.getCurrentMode().kind).toBe('cloud');

      // Now simulate the asynchronous close event that socket A fires
      // after setMode already re-pointed this.ws at socket B. The
      // helper should ignore it entirely: this.ws stays pinned to
      // newSocket, no reconnect is queued, and onClose is NOT invoked
      // (we already told the caller we switched modes).
      closeSocket(oldSocket, 1006, 'stale');

      // No onClose call — the close event came from a superseded socket.
      expect(cbs.closeCalls.length).toBe(0);

      // Open the new socket to confirm the helper still holds a valid
      // reference to it. If the stale close had nulled out this.ws we'd
      // see isOpen() stay false here.
      openSocket(newSocket);
      expect(conn.isOpen()).toBe(true);

      // Wait long enough that any reconnect timer would have fired.
      await new Promise((r) => setTimeout(r, 1100));

      // Still only the original two sockets — no spurious reconnect.
      expect(instances.length).toBe(2);

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
