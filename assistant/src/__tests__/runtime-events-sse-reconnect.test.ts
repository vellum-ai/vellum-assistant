/**
 * HTTP-layer tests for the B7.2 reconnect handler on GET /v1/events.
 *
 * Covers:
 *   - replay of buffered events when `lastSeenSeq` is in-window
 *   - snapshot-resync signal when `lastSeenSeq` is older than the ring
 *   - omitted `lastSeenSeq` falls through to legacy live-only behavior
 *   - dedup against live events that race in mid-replay
 *   - malformed `lastSeenSeq` query param rejected with 400
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

  test("replays buffered events with seq > lastSeenSeq before the first heartbeat", async () => {
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
        lastSeenSeq: "1",
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

  test("emits stream_resync_required when lastSeenSeq is older than the ring's oldest entry", async () => {
    const { conversationId } = getOrCreateConversation("reconnect-resync");

    // Push 202 events through stampAndBuffer so the ring's natural
    // count-based eviction (cap 200) drops seqs 1 and 2. The ring
    // window becomes [seq 3..seq 202] and a cursor of 0 is older
    // than oldest - 1 (= 2) -> snapshot fallback.
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
        conversationKey: "reconnect-resync",
        lastSeenSeq: "0",
      },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // First frame is the resync signal.
    const resyncFrame = await readFrame(reader);
    expect(resyncFrame).toContain("event: assistant_event");
    expect(resyncFrame).toContain('"type":"stream_resync_required"');
    expect(resyncFrame).toContain(`"conversationId":"${conversationId}"`);

    // Then the heartbeat.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("omitting lastSeenSeq skips replay entirely (legacy live-only behavior)", async () => {
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
          lastSeenSeq: "1",
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

  test("rejects empty lastSeenSeq", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-empty",
          lastSeenSeq: "",
        },
      }),
    ).toThrow(/lastSeenSeq must not be empty/);
  });

  test("rejects non-integer lastSeenSeq", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-float",
          lastSeenSeq: "1.5",
        },
      }),
    ).toThrow(/non-negative integer/);
  });

  test("rejects negative lastSeenSeq", async () => {
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: {
          conversationKey: "reconnect-neg",
          lastSeenSeq: "-1",
        },
      }),
    ).toThrow(/non-negative integer/);
  });
});
