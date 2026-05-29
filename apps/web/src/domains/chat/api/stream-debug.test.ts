import { describe, expect, test, beforeEach } from "bun:test";

import {
  getSseClients,
  getSseEvents,
  markClientEstablished,
  pushSseEvent,
  registerSseClient,
  resetSseDebugStateForTests,
  unregisterSseClient,
} from "@/domains/chat/api/stream-debug";
import type { AssistantEvent } from "@/types/event-types";

beforeEach(() => {
  resetSseDebugStateForTests();
});

function makeTextDeltaEvent(text: string): AssistantEvent {
  return { type: "assistant_text_delta", text, messageId: "msg-1" };
}

describe("registerSseClient", () => {
  test("returns a stable id with the expected prefix", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal, "conv-1");
    expect(id.startsWith("sse-")).toBe(true);
  });

  test("stores client with correct initial state", () => {
    const ctrl = new AbortController();
    const before = Date.now();
    const id = registerSseClient(ctrl.signal, "conv-2");
    const after = Date.now();

    const clients = getSseClients();
    const found = clients.find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.conversationId).toBe("conv-2");
    expect(found!.abortSignal).toBe(ctrl.signal);
    expect(found!.establishedAt).toBeNull();
    expect(found!.initiatedAt).toBeGreaterThanOrEqual(before);
    expect(found!.initiatedAt).toBeLessThanOrEqual(after);
  });

  test("auto-removes client when signal aborts", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal, "conv-3");
    expect(getSseClients().some((c) => c.id === id)).toBe(true);

    ctrl.abort();
    expect(getSseClients().some((c) => c.id === id)).toBe(false);
  });

  test("immediately removes client if already aborted", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const id = registerSseClient(ctrl.signal, "conv-4");
    expect(getSseClients().some((c) => c.id === id)).toBe(false);
  });

  test("unregisterSseClient explicitly removes a live client", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal, "conv-5");
    expect(getSseClients().some((c) => c.id === id)).toBe(true);

    unregisterSseClient(id);
    expect(getSseClients().some((c) => c.id === id)).toBe(false);
  });

  test("unregisterSseClient is idempotent for unknown ids", () => {
    // Should not throw
    unregisterSseClient("sse-nonexistent");
  });
});

describe("markClientEstablished", () => {
  test("sets establishedAt on first data frame", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal, "conv-a");

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
    const id = registerSseClient(ctrl.signal, "conv-b");
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
    const id = registerSseClient(ctrl.signal, "conv-x");
    const event = makeTextDeltaEvent("hello");

    const before = Date.now();
    pushSseEvent(id, event);
    const after = Date.now();

    const events = getSseEvents();
    const last = events[events.length - 1];
    expect(last.clientId).toBe(id);
    expect(last.event).toEqual(event);
    expect(last.receivedAt).toBeGreaterThanOrEqual(before);
    expect(last.receivedAt).toBeLessThanOrEqual(after);
  });

  test("caps event buffer at 1000 entries", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal, "conv-y");
    const event = makeTextDeltaEvent("x");

    // Push 1005 events; only last 1000 should be retained
    for (let i = 0; i < 1005; i++) {
      pushSseEvent(id, event);
    }

    const events = getSseEvents();
    expect(events.length).toBe(1000);
  });
});

describe("getSseEvents limit", () => {
  test("respects custom limit", () => {
    const ctrl = new AbortController();
    const id = registerSseClient(ctrl.signal, "conv-z");
    const event = makeTextDeltaEvent("x");

    for (let i = 0; i < 20; i++) {
      pushSseEvent(id, event);
    }

    expect(getSseEvents(5).length).toBe(5);
    expect(getSseEvents(50).length).toBe(20);
  });
});
