/**
 * Hardening tests for the SSE assistant-events endpoint (PR 7).
 *
 * Covers:
 *   - Hub evicts oldest subscriber when cap is reached.
 *   - SSE route closes evicted subscriber's stream.
 *   - Idle heartbeat comment emission.
 *   - Subscription cleanup on request abort.
 *   - Subscription cleanup on reader cancel.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "sse-hardening-")));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

// ── Hub subscriber cap — eviction ─────────────────────────────────────────────

describe("AssistantEventHub — subscriber cap", () => {
  test("evicts oldest subscriber when cap is reached", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });
    const evicted: string[] = [];

    const sub1 = hub.subscribe({ assistantId: "ast_1" }, () => {}, {
      onEvict: () => evicted.push("sub1"),
    });
    expect(hub.subscriberCount()).toBe(1);
    expect(sub1.active).toBe(true);

    // Adding sub2 evicts sub1 to make room.
    const sub2 = hub.subscribe({ assistantId: "ast_1" }, () => {}, {
      onEvict: () => evicted.push("sub2"),
    });

    expect(hub.subscriberCount()).toBe(1);
    expect(sub1.active).toBe(false);
    expect(sub2.active).toBe(true);
    expect(evicted).toEqual(["sub1"]);

    sub2.dispose();
  });

  test("evicts in FIFO order across multiple overflows", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 2 });
    const evicted: number[] = [];

    const sub1 = hub.subscribe({ assistantId: "ast_1" }, () => {}, {
      onEvict: () => evicted.push(1),
    });
    const sub2 = hub.subscribe({ assistantId: "ast_1" }, () => {}, {
      onEvict: () => evicted.push(2),
    });

    // 3rd subscriber evicts oldest (sub1)
    const sub3 = hub.subscribe({ assistantId: "ast_1" }, () => {}, {
      onEvict: () => evicted.push(3),
    });
    expect(evicted).toEqual([1]);
    expect(sub1.active).toBe(false);
    expect(sub2.active).toBe(true);

    // 4th subscriber evicts next oldest (sub2)
    const sub4 = hub.subscribe({ assistantId: "ast_1" }, () => {}, {
      onEvict: () => evicted.push(4),
    });
    expect(evicted).toEqual([1, 2]);
    expect(sub2.active).toBe(false);
    expect(sub3.active).toBe(true);
    expect(hub.subscriberCount()).toBe(2);

    sub3.dispose();
    sub4.dispose();
  });

  test("maxSubscribers: 0 throws RangeError (nothing to evict)", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 0 });
    expect(() => hub.subscribe({ assistantId: "ast_1" }, () => {})).toThrow(
      RangeError,
    );
  });

  test("subscribe succeeds after disposal frees a slot", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });
    const sub = hub.subscribe({ assistantId: "ast_1" }, () => {});
    sub.dispose();

    // Should not throw now that the slot is free.
    expect(() =>
      hub.subscribe({ assistantId: "ast_1" }, () => {}),
    ).not.toThrow();
  });

  test("default hub accepts many subscribers without eviction", () => {
    const hub = new AssistantEventHub();
    const N = 50;
    const subs = Array.from({ length: N }, () =>
      hub.subscribe({ assistantId: "ast_1" }, () => {}),
    );
    expect(hub.subscriberCount()).toBe(N);
    subs.forEach((s) => s.dispose());
    expect(hub.subscriberCount()).toBe(0);
  });
});

// ── SSE route — eviction on capacity overflow ──────────────────────────────────

describe("SSE route — capacity limit", () => {
  beforeEach(clearTables);

  test("new connection evicts oldest and returns 200", async () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });
    const opts = {
      hub,
      heartbeatIntervalMs: 60_000,
      skipActorVerification: true as const,
    };

    const ac1 = new AbortController();
    const req1 = new Request(
      "http://localhost/v1/events?conversationKey=evict-a",
      { signal: ac1.signal },
    );
    const res1 = handleSubscribeAssistantEvents(req1, new URL(req1.url), opts);
    expect(res1.status).toBe(200);
    expect(hub.subscriberCount()).toBe(1);

    const reader1 = res1.body!.getReader();

    // Second connection evicts first.
    const ac2 = new AbortController();
    const req2 = new Request(
      "http://localhost/v1/events?conversationKey=evict-b",
      { signal: ac2.signal },
    );
    const res2 = handleSubscribeAssistantEvents(req2, new URL(req2.url), opts);
    expect(res2.status).toBe(200);
    expect(hub.subscriberCount()).toBe(1); // evicted 1, added 1

    // First stream: the immediate heartbeat was enqueued during start(),
    // then eviction closed the controller.  Read past any buffered data
    // until the stream signals done.
    let evictDone = false;
    while (!evictDone) {
      const result = await reader1.read();
      evictDone = result.done;
    }
    expect(evictDone).toBe(true);

    ac2.abort();
  });

  test("returns 503 only when maxSubscribers is 0", async () => {
    const hub = new AssistantEventHub({ maxSubscribers: 0 });
    const req = new Request(
      "http://localhost/v1/events?conversationKey=cap-zero-test",
      { signal: new AbortController().signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      skipActorVerification: true,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toMatch(/Too many concurrent connections/);
  });

  test("returns 200 when hub has remaining capacity", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 2 });
    const ac = new AbortController();
    const req = new Request(
      "http://localhost/v1/events?conversationKey=cap-ok-test",
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      skipActorVerification: true,
    });

    expect(response.status).toBe(200);
    ac.abort(); // clean up the subscription
  });
});

// ── SSE route — heartbeat ────────────────────────────────────────────────────

describe("SSE route — heartbeat", () => {
  beforeEach(clearTables);

  test("emits SSE comment frames on the configured interval", async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      "http://localhost/v1/events?conversationKey=hb-emit-test",
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      heartbeatIntervalMs: 10,
      skipActorVerification: true,
    });

    // Wait for at least one heartbeat interval to fire.
    await new Promise((r) => setTimeout(r, 30));

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    ac.abort();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    expect(text).toBe(": heartbeat\n\n");
  });

  test("emits multiple heartbeats over time", async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      "http://localhost/v1/events?conversationKey=hb-multi-test",
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      heartbeatIntervalMs: 10,
      skipActorVerification: true,
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
    expect(chunks.every((c) => c === ": heartbeat\n\n")).toBe(true);
  });
});

// ── SSE route — disconnect cleanup ───────────────────────────────────────────

describe("SSE route — disconnect cleanup", () => {
  beforeEach(clearTables);

  test("aborting the request disposes the subscription", async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      "http://localhost/v1/events?conversationKey=abort-cleanup-test",
      { signal: ac.signal },
    );

    handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      skipActorVerification: true,
    });

    expect(hub.subscriberCount()).toBe(1);

    ac.abort();

    // Give the abort listener a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(hub.subscriberCount()).toBe(0);
  });

  test("cancelling the reader disposes the subscription", async () => {
    const hub = new AssistantEventHub();
    const ac = new AbortController();
    const req = new Request(
      "http://localhost/v1/events?conversationKey=cancel-cleanup-test",
      { signal: ac.signal },
    );

    const response = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      skipActorVerification: true,
    });

    expect(hub.subscriberCount()).toBe(1);

    const reader = response.body!.getReader();
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 0));

    expect(hub.subscriberCount()).toBe(0);
    ac.abort();
  });
});
