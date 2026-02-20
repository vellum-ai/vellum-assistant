/**
 * Hardening tests for the SSE assistant-events endpoint (PR 7).
 *
 * Covers:
 *   - Hub subscriber cap (RangeError on overflow).
 *   - SSE route returns 503 when the hub is at capacity.
 *   - Idle heartbeat comment emission.
 *   - Subscription cleanup on request abort.
 *   - Subscription cleanup on reader cancel.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'sse-hardening-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { AssistantEventHub } from '../runtime/assistant-event-hub.js';
import { handleSubscribeAssistantEvents } from '../runtime/routes/events-routes.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearTables() {
  const db = getDb();
  db.run('DELETE FROM conversation_keys');
  db.run('DELETE FROM conversations');
}

// ── Hub subscriber cap ────────────────────────────────────────────────────────

describe('AssistantEventHub — subscriber cap', () => {
  test('subscribe throws RangeError when cap is reached', () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });
    hub.subscribe({ assistantId: 'ast_1' }, () => {});

    expect(() => hub.subscribe({ assistantId: 'ast_1' }, () => {})).toThrow(RangeError);
  });

  test('error message includes the cap limit', () => {
    const hub = new AssistantEventHub({ maxSubscribers: 2 });
    hub.subscribe({ assistantId: 'ast_1' }, () => {});
    hub.subscribe({ assistantId: 'ast_1' }, () => {});

    expect(() => hub.subscribe({ assistantId: 'ast_1' }, () => {}))
      .toThrow(/subscriber cap reached \(2\)/);
  });

  test('subscribe succeeds after disposal frees a slot', () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });
    const sub = hub.subscribe({ assistantId: 'ast_1' }, () => {});
    sub.dispose();

    // Should not throw now that the slot is free.
    expect(() => hub.subscribe({ assistantId: 'ast_1' }, () => {})).not.toThrow();
  });

  test('default hub has no cap', () => {
    const hub = new AssistantEventHub();
    const N = 50;
    const subs = Array.from({ length: N }, () =>
      hub.subscribe({ assistantId: 'ast_1' }, () => {}),
    );
    expect(hub.subscriberCount()).toBe(N);
    subs.forEach((s) => s.dispose());
    expect(hub.subscriberCount()).toBe(0);
  });
});

// ── SSE route — 503 on capacity overflow ──────────────────────────────────────

describe('SSE route — capacity limit', () => {
  beforeEach(clearTables);

  test('returns 503 when hub is at capacity', () => {
    const hub = new AssistantEventHub({ maxSubscribers: 0 });
    const req = new Request(
      'http://localhost/v1/events?conversationKey=cap-full-test',
      { signal: new AbortController().signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), { hub });

    expect(response.status).toBe(503);
  });

  test('503 body contains error message', async () => {
    const hub = new AssistantEventHub({ maxSubscribers: 0 });
    const req = new Request(
      'http://localhost/v1/events?conversationKey=cap-body-test',
      { signal: new AbortController().signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), { hub });
    const body = await response.json() as { error: string };

    expect(body.error).toMatch(/Too many concurrent connections/);
  });

  test('returns 200 when hub has remaining capacity', () => {
    const hub = new AssistantEventHub({ maxSubscribers: 2 });
    const ac = new AbortController();
    const req = new Request(
      'http://localhost/v1/events?conversationKey=cap-ok-test',
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), { hub });

    expect(response.status).toBe(200);
    ac.abort(); // clean up the subscription
  });
});

// ── SSE route — heartbeat ────────────────────────────────────────────────────

describe('SSE route — heartbeat', () => {
  beforeEach(clearTables);

  test('emits SSE comment frames on the configured interval', async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      'http://localhost/v1/events?conversationKey=hb-emit-test',
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      heartbeatIntervalMs: 10,
    });

    // Wait for at least one heartbeat interval to fire.
    await new Promise((r) => setTimeout(r, 30));

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    ac.abort();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    expect(text).toBe(': heartbeat\n\n');
  });

  test('emits multiple heartbeats over time', async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      'http://localhost/v1/events?conversationKey=hb-multi-test',
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      heartbeatIntervalMs: 10,
    });

    // Wait for several intervals.
    await new Promise((r) => setTimeout(r, 50));

    const chunks: string[] = [];
    const reader = response.body!.getReader();
    // Drain without blocking by reading with a short deadline.
    for (let i = 0; i < 3; i++) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 20),
        ),
      ]);
      if (done || !value) break;
      chunks.push(new TextDecoder().decode(value));
    }

    ac.abort();
    reader.cancel();

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c === ': heartbeat\n\n')).toBe(true);
  });
});

// ── SSE route — disconnect cleanup ───────────────────────────────────────────

describe('SSE route — disconnect cleanup', () => {
  beforeEach(clearTables);

  test('aborting the request disposes the subscription', async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      'http://localhost/v1/events?conversationKey=abort-cleanup-test',
      { signal: ac.signal },
    );

    handleSubscribeAssistantEvents(req, new URL(req.url), { hub });

    expect(hub.subscriberCount()).toBe(1);

    ac.abort();

    // Give the abort listener a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(hub.subscriberCount()).toBe(0);
  });

  test('cancelling the reader disposes the subscription', async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      'http://localhost/v1/events?conversationKey=cancel-cleanup-test',
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), { hub });

    expect(hub.subscriberCount()).toBe(1);

    const reader = response.body!.getReader();
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 0));

    expect(hub.subscriberCount()).toBe(0);
    ac.abort();
  });
});
