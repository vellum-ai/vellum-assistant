/**
 * HTTP-layer tests for the reconnect (resumable-stream) handler on
 * GET /v1/events.
 *
 * Covers:
 *   - replay of buffered events when a conversation's cursor is in-window
 *   - cursor older than the ring -> that conversation goes live without
 *     any extra wire signal (client is expected to detect the seq jump
 *     and refetch via the messages API)
 *   - omitted `lastSeenSeqs` falls through to legacy live-only behavior
 *   - dedup against live events that race in mid-replay
 *   - an unfiltered subscription replays multiple conversations' gaps
 *     independently from a single cursor map
 *   - malformed `lastSeenSeqs` query param rejected with 400
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import {
  _resetConversationStreamsForTesting,
  stampAndBuffer,
} from "../runtime/conversation-stream-state.js";

initializeDb();

const decoder = new TextDecoder();

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return decoder.decode(value);
}

describe("SSE reconnect replay (B7.2)", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
    _resetConversationStreamsForTesting();
  });

  afterEach(() => {
    _resetConversationStreamsForTesting();
  });

  test("replays buffered events with seq > the conversation's cursor before the first heartbeat", async () => {
    const { conversationId } = getOrCreateConversation("reconnect-replay");

    // Stamp three events into the ring as if they had already been
    // broadcast prior to the client's reconnect. Seqs start at 1, so
    // these get seqs 1, 2, 3.
    const events = [
      buildAssistantEvent({ type: "pong" }, conversationId),
      buildAssistantEvent({ type: "pong" }, conversationId),
      buildAssistantEvent({ type: "pong" }, conversationId),
    ];
    for (const event of events) stampAndBuffer(event);

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents({
      queryParams: {
        conversationKey: "reconnect-replay",
        lastSeenSeqs: JSON.stringify({ [conversationId]: 1 }),
      },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // Frames 1-2 are the two events with seq > 1 (i.e. seqs 2 and 3),
    // emitted before the initial heartbeat.
    const frame1 = await readFrame(reader);
    expect(frame1).toContain("event: assistant_event");
    expect(frame1).toContain('"seq":2');

    const frame2 = await readFrame(reader);
    expect(frame2).toContain('"seq":3');

    // Then the heartbeat.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("connects live without replay when the cursor is older than the ring's oldest entry", async () => {
    // When the client's cursor is older than the ring can serve, the
    // route deliberately does NOT signal anything special over the
    // wire -- the connection just goes live. The client is expected to
    // detect the gap from the seq jump on its first live event and
    // refetch via the existing messages API.
    const { conversationId } = getOrCreateConversation(
      "reconnect-out-of-window",
    );

    // Push 202 events through stampAndBuffer so the ring's natural
    // count-based eviction (cap 200) drops seqs 1 and 2. A cursor of
    // 0 then falls outside what getReplayWindow can serve.
    for (let i = 0; i < 202; i++) {
      stampAndBuffer(buildAssistantEvent({ type: "pong" }, conversationId));
    }
    const { _peekStreamForTesting } =
      await import("../runtime/conversation-stream-state.js");
    const peek = _peekStreamForTesting(conversationId);
    expect(peek?.oldestSeq).toBe(3);
    expect(peek?.newestSeq).toBe(202);

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents({
      queryParams: {
        conversationKey: "reconnect-out-of-window",
        lastSeenSeqs: JSON.stringify({ [conversationId]: 0 }),
      },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // No replay events ahead of the heartbeat -- the cursor was
    // unserviceable so the route emits nothing extra.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("omitting lastSeenSeqs skips replay entirely (legacy live-only behavior)", async () => {
    const { conversationId } = getOrCreateConversation("reconnect-noparam");

    // Pre-fill the ring -- without the cursor, these MUST NOT be replayed.
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, conversationId));
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, conversationId));

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents({
      queryParams: { conversationKey: "reconnect-noparam" },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // First frame is the heartbeat -- no replay events ahead of it.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("dedupes a buffered event when it also races through the live callback", async () => {
    const { conversationId } = getOrCreateConversation("reconnect-dedup");

    // Stamp two events. Seqs start at 1, so eventA=1 and eventB=2.
    const eventA = buildAssistantEvent({ type: "pong" }, conversationId);
    const eventB = buildAssistantEvent({ type: "pong" }, conversationId);
    stampAndBuffer(eventA); // seq 1
    stampAndBuffer(eventB); // seq 2

    const ac = new AbortController();
    const { AssistantEventHub } =
      await import("../runtime/assistant-event-hub.js");
    const testHub = new AssistantEventHub();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: {
          conversationKey: "reconnect-dedup",
          lastSeenSeqs: JSON.stringify({ [conversationId]: 1 }),
        },
        abortSignal: ac.signal,
      },
      { hub: testHub },
    );

    const reader = stream.getReader();

    // First frame is the replay of seq=2 (the only one with seq > 1).
    const replayed = await readFrame(reader);
    expect(replayed).toContain('"seq":2');

    // Then the heartbeat.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    // Now publish eventB live (its seq is 2, already replayed). The
    // callback's high-water dedup should drop it. Then publish a fresh
    // event with seq=3 (via stampAndBuffer + manual publish), which
    // SHOULD be delivered.
    await testHub.publish(eventB);

    const eventC = buildAssistantEvent({ type: "pong" }, conversationId);
    stampAndBuffer(eventC); // seq 3
    await testHub.publish(eventC);

    const liveFrame = await readFrame(reader);
    expect(liveFrame).toContain('"seq":3');

    ac.abort();
  });

  test("replays multiple conversations independently on an unfiltered subscription", async () => {
    // GIVEN two conversations, each with its own buffered events in an
    // independent per-conversation seq space.
    const a = getOrCreateConversation("reconnect-multi-a");
    const b = getOrCreateConversation("reconnect-multi-b");
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, a.conversationId)); // A seq 1
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, a.conversationId)); // A seq 2
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, b.conversationId)); // B seq 1
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, b.conversationId)); // B seq 2

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");

    // WHEN an unfiltered (assistant-wide) subscription reconnects with a
    // cursor map covering both conversations at seq 1.
    const stream = handleSubscribeAssistantEvents({
      queryParams: {
        lastSeenSeqs: JSON.stringify({
          [a.conversationId]: 1,
          [b.conversationId]: 1,
        }),
      },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // THEN each conversation's missed event (its seq 2) is replayed
    // before the first heartbeat, scoped to its own conversation id.
    const frame1 = await readFrame(reader);
    const frame2 = await readFrame(reader);
    const replayed = `${frame1}${frame2}`;
    expect(replayed).toContain(a.conversationId);
    expect(replayed).toContain(b.conversationId);
    expect(frame1).toContain('"seq":2');
    expect(frame2).toContain('"seq":2');

    // AND the heartbeat follows once both gaps are drained.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("skips one conversation whose cursor is out of window while replaying another", async () => {
    // GIVEN conversation A whose oldest buffered seq is evicted past its
    // cursor, AND conversation B with an in-window cursor.
    const a = getOrCreateConversation("reconnect-multi-stale-a");
    const b = getOrCreateConversation("reconnect-multi-fresh-b");
    for (let i = 0; i < 202; i++) {
      stampAndBuffer(buildAssistantEvent({ type: "pong" }, a.conversationId));
    }
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, b.conversationId)); // B seq 1
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, b.conversationId)); // B seq 2

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");

    // WHEN an unfiltered subscription reconnects with A's cursor older
    // than its ring and B's cursor in-window.
    const stream = handleSubscribeAssistantEvents({
      queryParams: {
        lastSeenSeqs: JSON.stringify({
          [a.conversationId]: 0,
          [b.conversationId]: 1,
        }),
      },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // THEN only B's missed event replays (A is skipped silently), then
    // the heartbeat.
    const frame1 = await readFrame(reader);
    expect(frame1).toContain(b.conversationId);
    expect(frame1).toContain('"seq":2');

    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("rejects empty lastSeenSeqs", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-empty",
          lastSeenSeqs: "",
        },
      }),
    ).toThrow(/lastSeenSeqs must not be empty/);
  });

  test("rejects non-JSON lastSeenSeqs", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-badjson",
          lastSeenSeqs: "not-json",
        },
      }),
    ).toThrow(/valid JSON object/);
  });

  test("rejects non-integer seq in lastSeenSeqs", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-float",
          lastSeenSeqs: JSON.stringify({ "conv-1": 1.5 }),
        },
      }),
    ).toThrow(/non-negative integer seqs/);
  });

  test("rejects negative seq in lastSeenSeqs", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-neg",
          lastSeenSeqs: JSON.stringify({ "conv-1": -1 }),
        },
      }),
    ).toThrow(/non-negative integer seqs/);
  });
});
