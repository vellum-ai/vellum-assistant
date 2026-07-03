import { describe, expect, test, beforeEach } from "bun:test";

import {
  endSseClient,
  getSseClients,
  getSseEnvelopesSince,
  getSseEvents,
  markClientEstablished,
  pushSseEvent,
  recordSseTraffic,
  registerSseClient,
  resetSseDebugStateForTests,
} from "@/lib/streaming/stream-debug";
import type { AssistantEvent } from "@/types/event-types";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

beforeEach(() => {
  resetSseDebugStateForTests();
});

function makeTextDeltaEvent(text: string): AssistantEvent {
  return { type: "assistant_text_delta", text, messageId: "msg-1" };
}

function makeEnvelope(
  message: AssistantEvent,
  overrides: Partial<AssistantEventEnvelope> = {},
): AssistantEventEnvelope {
  return {
    id: "evt",
    conversationId: "conv-A",
    seq: 1,
    emittedAt: new Date(1000).toISOString(),
    message,
    ...overrides,
  } as AssistantEventEnvelope;
}

describe("registerSseClient", () => {
  test("returns a stable id with the expected prefix", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    expect(id.startsWith("sse-")).toBe(true);
  });

  test("stores client with correct initial state", () => {
    const ctrl = new AbortController();
    const before = Date.now();
    const id = registerSseClient(ctrl.signal);
    const after = Date.now();

    const clients = getSseClients();
    const found = clients.find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.abortSignal).toBe(ctrl.signal);
    expect(found!.establishedAt).toBeNull();
    expect(found!.initiatedAt).toBeGreaterThanOrEqual(before);
    expect(found!.initiatedAt).toBeLessThanOrEqual(after);
    expect(found!.lastTrafficAt).toBeNull();
    expect(found!.lastDataAt).toBeNull();
    expect(found!.dataFrames).toBe(0);
    expect(found!.keepalives).toBe(0);
    // AND it starts out live (no end metadata yet)
    expect(found!.endedAt).toBeNull();
    expect(found!.endReason).toBeNull();
  });

  test("retains the client (marked ended) when signal aborts", () => {
    // GIVEN a live registered client
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);

    // WHEN its abort signal fires
    ctrl.abort();

    // THEN the client is retained for inspection, marked ended via the
    // safety-net "aborted" reason rather than deleted
    const found = getSseClients().find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.endedAt).not.toBeNull();
    expect(found!.endReason).toBe("aborted");
  });

  test("retains the client (marked ended) if already aborted at register", () => {
    // GIVEN an already-aborted signal
    const ctrl = new AbortController();
    ctrl.abort();

    // WHEN a client is registered against it
    const id = registerSseClient(ctrl.signal);

    // THEN it is retained and immediately marked ended
    const found = getSseClients().find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.endReason).toBe("aborted");
  });
});

describe("endSseClient", () => {
  test("marks a live client ended with the given reason", () => {
    // GIVEN a live registered client
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    const before = Date.now();

    // WHEN it is ended explicitly
    endSseClient(id, "ended");
    const after = Date.now();

    // THEN it is retained with end metadata
    const found = getSseClients().find((c) => c.id === id)!;
    expect(found.endReason).toBe("ended");
    expect(found.endedAt!).toBeGreaterThanOrEqual(before);
    expect(found.endedAt!).toBeLessThanOrEqual(after);
  });

  test("upgrades the safety-net 'aborted' reason to a precise one", () => {
    // GIVEN a client whose abort fired first (recording "aborted")
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    ctrl.abort();
    const endedAt = getSseClients().find((c) => c.id === id)!.endedAt;

    // WHEN the transport later reports the precise reason
    endSseClient(id, "watchdog");

    // THEN the reason is upgraded but the original end time is preserved
    const found = getSseClients().find((c) => c.id === id)!;
    expect(found.endReason).toBe("watchdog");
    expect(found.endedAt).toBe(endedAt);
  });

  test("does not downgrade a precise reason back to 'aborted'", () => {
    // GIVEN a client ended with a precise reason
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    endSseClient(id, "ended");

    // WHEN a later safety-net abort fires
    endSseClient(id, "aborted");

    // THEN the precise reason is preserved
    expect(getSseClients().find((c) => c.id === id)!.endReason).toBe("ended");
  });

  test("is idempotent for unknown ids", () => {
    // WHEN ending a client that was never registered
    // THEN it does not throw
    expect(() => endSseClient("sse-nonexistent", "ended")).not.toThrow();
  });
});

describe("getSseClients history retention", () => {
  test("returns live and recently-ended clients side by side", () => {
    // GIVEN one ended client and one still-live client
    const first = registerSseClient(new AbortController().signal);
    endSseClient(first, "watchdog");
    const second = registerSseClient(new AbortController().signal);

    // WHEN the snapshot is read
    const ids = getSseClients().map((c) => c.id);

    // THEN both are present, in registration order
    expect(ids).toEqual([first, second]);
  });

  test("evicts oldest ended clients beyond the cap but keeps live ones", () => {
    // GIVEN a live client registered first
    const live = registerSseClient(new AbortController().signal);

    // AND more ended clients than the retention cap (15)
    const endedIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = registerSseClient(new AbortController().signal);
      endSseClient(id, "ended");
      endedIds.push(id);
    }

    // WHEN the snapshot is read
    const clients = getSseClients();
    const ids = clients.map((c) => c.id);

    // THEN only the 15 most-recent ended clients are retained
    const retainedEnded = ids.filter((id) => id !== live);
    expect(retainedEnded).toEqual(endedIds.slice(endedIds.length - 15));
    // AND the live client is never evicted
    expect(ids).toContain(live);
  });
});

describe("markClientEstablished", () => {
  test("sets establishedAt on first data frame", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);

    const before = Date.now();
    markClientEstablished(id);
    const after = Date.now();

    const client = getSseClients().find((c) => c.id === id)!;
    expect(client.establishedAt).not.toBeNull();
    expect(client.establishedAt!).toBeGreaterThanOrEqual(before);
    expect(client.establishedAt!).toBeLessThanOrEqual(after);
  });

  test("is idempotent — does not overwrite establishedAt", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    markClientEstablished(id);
    const first = getSseClients().find((c) => c.id === id)!.establishedAt;

    // wait a tick so timestamps would differ
    const start = Date.now();
    while (Date.now() - start < 2) { /* busy wait */ }

    markClientEstablished(id);
    const second = getSseClients().find((c) => c.id === id)!.establishedAt;
    expect(second).toBe(first);
  });

  test("no-op for unknown client id", () => {
    // Should not throw
    markClientEstablished("sse-nonexistent");
  });
});

describe("pushSseEvent", () => {
  test("records event with client id and timestamp", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    const event = makeTextDeltaEvent("hello");

    const before = Date.now();
    pushSseEvent(id, makeEnvelope(event));
    const after = Date.now();

    const events = getSseEvents();
    const last = events[events.length - 1];
    expect(last.clientId).toBe(id);
    expect(last.message as AssistantEvent).toEqual(event);
    expect(last.receivedAt).toBe(new Date(last.receivedAt).toISOString());
    const receivedMs = new Date(last.receivedAt).getTime();
    expect(receivedMs).toBeGreaterThanOrEqual(before);
    expect(receivedMs).toBeLessThanOrEqual(after);
  });

  test("caps event buffer at 1000 entries", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    const event = makeTextDeltaEvent("x");

    // Push 1005 events; only last 1000 should be retained
    for (let i = 0; i < 1005; i++) {
      pushSseEvent(id, makeEnvelope(event, { seq: i }));
    }

    const events = getSseEvents();
    expect(events.length).toBe(1000);
  });
});

describe("getSseEvents limit", () => {
  test("respects custom limit", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    const event = makeTextDeltaEvent("x");

    for (let i = 0; i < 20; i++) {
      pushSseEvent(id, makeEnvelope(event, { seq: i }));
    }

    expect(getSseEvents(5).length).toBe(5);
    expect(getSseEvents(50).length).toBe(20);
  });
});

describe("getSseEnvelopesSince", () => {
  test("returns the conversation's tail with seq > sinceSeq, in seq order", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    // Two conversations interleaved with sparse, non-consecutive global seqs.
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("a3"), { seq: 3, conversationId: "A" }));
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("b4"), { seq: 4, conversationId: "B" }));
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("a9"), { seq: 9, conversationId: "A" }));
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("a7"), { seq: 7, conversationId: "A" }));

    const tail = getSseEnvelopesSince("A", 3);
    expect(tail?.map((e) => e.seq)).toEqual([7, 9]); // > 3, A only, seq-ordered
    expect(tail![0]!.message as AssistantEvent).toEqual(makeTextDeltaEvent("a7"));
    expect(tail![0]!.emittedAt).toBe(new Date(1000).toISOString());
  });

  test("returns null when the ring no longer covers the cursor (eviction gap)", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    // Oldest retained seq (50) is well past sinceSeq+1 — seqs 4..49 were
    // evicted, so a replay would be a partial tail. Signal a gap instead.
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("a50"), { seq: 50, conversationId: "A" }));
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("a60"), { seq: 60, conversationId: "A" }));
    expect(getSseEnvelopesSince("A", 3)).toBeNull();
  });

  test("returns null without a version anchor (snapshot must stand alone)", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("x"), { seq: 5, conversationId: "A" }));
    expect(getSseEnvelopesSince("A", null)).toBeNull();
  });

  test("returns [] when covered but the conversation has no newer events", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("b6"), { seq: 6, conversationId: "B" }));
    expect(getSseEnvelopesSince("A", 5)).toEqual([]); // oldest 6 <= 5+1, covered
  });

  test("skips entries with no seq (can't be ordered or gated)", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    // An envelope with no `seq` at all (seq omitted, not set to undefined).
    pushSseEvent(id, {
      id: "no-seq",
      conversationId: "A",
      emittedAt: new Date(1000).toISOString(),
      message: makeTextDeltaEvent("x"),
    } as AssistantEventEnvelope);
    pushSseEvent(id, makeEnvelope(makeTextDeltaEvent("y"), { seq: 6, conversationId: "A" }));
    expect(getSseEnvelopesSince("A", 5)?.map((e) => e.seq)).toEqual([6]);
  });
});

describe("recordSseTraffic", () => {
  test("counts data frames and keepalives separately on the client", () => {
    // GIVEN a live client
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);

    // WHEN a mix of data frames and heartbeat comment frames arrive
    recordSseTraffic(id, true);
    recordSseTraffic(id, false);
    recordSseTraffic(id, true);

    // THEN data and keepalive frames are tallied independently
    const client = getSseClients().find((c) => c.id === id)!;
    expect(client.dataFrames).toBe(2);
    expect(client.keepalives).toBe(1);
    // AND both freshness timestamps are present once any frame has arrived
    expect(client.lastTrafficAt).not.toBeNull();
    expect(client.lastDataAt).not.toBeNull();
  });

  test("tracks last-data time independently of heartbeat-only traffic", () => {
    // GIVEN a client received a data frame, then only heartbeats kept it warm
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal);
    recordSseTraffic(id, true);
    const start = Date.now();
    while (Date.now() - start < 3) {
      /* busy wait so a later heartbeat has a distinct timestamp */
    }
    recordSseTraffic(id, false);

    // WHEN the client snapshot is read
    const client = getSseClients().find((c) => c.id === id)!;

    // THEN last *data* is older than last *traffic* (a half-open shape)
    expect(client.lastDataAt!).toBeLessThan(client.lastTrafficAt!);
  });

  test("is a no-op for an unknown client id", () => {
    // GIVEN no client registered under this id
    // WHEN traffic is recorded against it
    // THEN it does not throw and records nothing
    expect(() => recordSseTraffic("sse-nonexistent", true)).not.toThrow();
  });
});
