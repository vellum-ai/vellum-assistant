/**
 * Tests for `GET /v1/events/tail` — the replay-by-request companion to the
 * SSE `lastSeenSeq` resume.
 *
 * Pins:
 *  1. The tail is the conversation-filtered ring window with
 *     `seq > fromSeq`, ascending, with `frontier` at the last returned seq.
 *  2. `complete: false` when the ring no longer reaches back to `fromSeq`
 *     (eviction) — the caller must recover from the snapshot alone.
 *  3. Targeting filters are re-applied from the caller's client identity
 *     headers, mirroring the SSE replay path.
 *  4. Input validation rejects missing/invalid params.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  _resetStreamStateForTesting,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/events-routes.js";

const CONV = "conv-a";
const OTHER = "conv-b";

const tailRoute = ROUTES.find((r) => r.operationId === "events_tail_get");
if (!tailRoute) {
  throw new Error("events_tail_get route not registered");
}

interface TailResponse {
  events: AssistantEvent[];
  complete: boolean;
  frontier: number | null;
}

function callTail(
  query: Record<string, string>,
  headers?: Record<string, string>,
): TailResponse {
  return tailRoute!.handler({
    queryParams: query,
    headers,
  }) as TailResponse;
}

function mkEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  const conversationId =
    "conversationId" in overrides ? overrides.conversationId : CONV;
  return {
    id: `uuid-${Math.random().toString(36).slice(2, 10)}`,
    conversationId,
    emittedAt: new Date().toISOString(),
    message: {
      type: "assistant_text_delta",
      conversationId,
      text: "x",
    },
    ...overrides,
  } as AssistantEvent;
}

describe("GET events/tail", () => {
  beforeEach(() => {
    _resetStreamStateForTesting();
  });

  test("returns the conversation's tail above fromSeq with the frontier", () => {
    // GIVEN interleaved events across two conversations (seq 1..6)
    for (let i = 0; i < 3; i++) {
      stampAndBuffer(mkEvent()); // CONV: seq 1, 3, 5
      stampAndBuffer(mkEvent({ conversationId: OTHER })); // OTHER: 2, 4, 6
    }

    // WHEN fetching CONV's tail above seq 1 (a snapshot anchored at 1)
    const body = callTail({ conversationId: CONV, fromSeq: "1" });

    // THEN only CONV's newer events come back, ascending, with the frontier
    expect(body.complete).toBe(true);
    expect(body.events.map((e) => e.seq)).toEqual([3, 5]);
    expect(body.events.every((e) => e.conversationId === CONV)).toBe(true);
    expect(body.frontier).toBe(5);
  });

  test("an up-to-date anchor yields an empty but complete tail", () => {
    // GIVEN three buffered events (seq 1..3)
    for (let i = 0; i < 3; i++) {
      stampAndBuffer(mkEvent());
    }

    // WHEN fetching from the live frontier
    const body = callTail({ conversationId: CONV, fromSeq: "3" });

    // THEN nothing is missing and the frontier is the anchor itself
    expect(body.complete).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.frontier).toBe(3);
  });

  test("reports complete=false when the ring no longer covers fromSeq", () => {
    // GIVEN a ring whose oldest retained entry is well past the anchor:
    // overflow the 200-event count bound so seq 1 is evicted
    for (let i = 0; i < 210; i++) {
      stampAndBuffer(mkEvent());
    }

    // WHEN fetching from a pre-eviction anchor
    const body = callTail({ conversationId: CONV, fromSeq: "1" });

    // THEN no contiguous tail can be served
    expect(body.complete).toBe(false);
    expect(body.events).toEqual([]);
    expect(body.frontier).toBeNull();
  });

  test("re-applies targeting filters from the caller's client identity", () => {
    // GIVEN an event excluded from a specific client (self-echo suppression)
    stampAndBuffer(mkEvent()); // seq 1 — untargeted
    stampAndBuffer(mkEvent(), { targeting: { excludeClientId: "client-1" } }); // seq 2

    // WHEN the excluded client fetches the tail
    const excluded = callTail(
      { conversationId: CONV, fromSeq: "0" },
      { "x-vellum-client-id": "client-1", "x-vellum-interface-id": "web" },
    );
    // AND a different client fetches the same tail
    const other = callTail(
      { conversationId: CONV, fromSeq: "0" },
      { "x-vellum-client-id": "client-2", "x-vellum-interface-id": "web" },
    );

    // THEN the targeted event is withheld only from its excluded client
    expect(excluded.events.map((e) => e.seq)).toEqual([1]);
    expect(other.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("toSeq bounds the window inclusively and moves the frontier", () => {
    // GIVEN five buffered events for the conversation (seq 1..5)
    for (let i = 0; i < 5; i++) {
      stampAndBuffer(mkEvent());
    }

    // WHEN fetching (1, 3] — the caller already has 4+ from live delivery
    const body = callTail({ conversationId: CONV, fromSeq: "1", toSeq: "3" });

    // THEN only the hole comes back, with the frontier at the bound
    expect(body.complete).toBe(true);
    expect(body.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(body.frontier).toBe(3);
  });

  test("rejects missing or invalid params", () => {
    expect(() => callTail({ fromSeq: "1" })).toThrow(BadRequestError);
    expect(() => callTail({ conversationId: CONV })).toThrow(BadRequestError);
    expect(() =>
      callTail({ conversationId: CONV, fromSeq: "not-a-number" }),
    ).toThrow(BadRequestError);
    expect(() => callTail({ conversationId: CONV, fromSeq: "-1" })).toThrow(
      BadRequestError,
    );
    expect(() => callTail({ conversationId: CONV, fromSeq: "1.5" })).toThrow(
      BadRequestError,
    );
    expect(() =>
      callTail({ conversationId: CONV, fromSeq: "5", toSeq: "3" }),
    ).toThrow(BadRequestError);
    expect(() =>
      callTail({ conversationId: CONV, fromSeq: "1", toSeq: "x" }),
    ).toThrow(BadRequestError);
  });
});
