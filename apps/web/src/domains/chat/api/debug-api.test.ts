import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

import { eventsDebugApi } from "@/domains/chat/api/debug-api";
import { __resetForTesting, publish } from "@/lib/event-bus";

afterEach(() => {
  __resetForTesting();
});

function makeEnvelope(): AssistantEventEnvelope {
  return {
    id: "evt-1",
    emittedAt: new Date().toISOString(),
    message: { type: "conversation_list_invalidated", reason: "created" },
  };
}

describe("eventsDebugApi", () => {
  test("exposes getClients and getEvents callable accessors", () => {
    expect(typeof eventsDebugApi.getClients).toBe("function");
    expect(typeof eventsDebugApi.getEvents).toBe("function");
    expect(Array.isArray(eventsDebugApi.getClients())).toBe(true);
    expect(Array.isArray(eventsDebugApi.getEvents())).toBe(true);
  });

  test("subscribe() logs live events and returns an unsubscribe handle", () => {
    /**
     * Tests that subscribe() taps the live SSE bus, console.logs each
     * envelope, and stops once the returned handle is invoked.
     */

    // GIVEN console.log is spied on
    const logSpy = mock(() => {});
    const original = console.log;
    console.log = logSpy;
    try {
      // AND a live subscription is active
      const unsubscribe = eventsDebugApi.subscribe();
      expect(typeof unsubscribe).toBe("function");

      // WHEN an SSE event is published on the bus
      const envelope = makeEnvelope();
      publish("sse.event", envelope);

      // THEN the envelope is logged once
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenLastCalledWith(
        "[_vellumDebug.events]",
        envelope,
      );

      // AND no further events are logged after unsubscribing
      unsubscribe();
      publish("sse.event", makeEnvelope());
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.log = original;
    }
  });
});
