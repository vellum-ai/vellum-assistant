/**
 * HTTP-layer tests for the B7.2 reconnect handler on GET /v1/events.
 *
 * Covers:
 *   - replay of buffered events when `lastSeenSeq` is in-window
 *   - cursor older than the ring -> connection goes live without any
 *     extra wire signal (client is expected to detect the seq jump
 *     and refetch via the messages API)
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
    expect(frame1).toContain('"clientSeq":1');

    const frame2 = await readFrame(reader);
    expect(frame2).toContain('"seq":3');
    expect(frame2).toContain('"clientSeq":2');

    // Then the heartbeat.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("connects live without replay when lastSeenSeq is older than the ring's oldest entry", async () => {
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
        lastSeenSeq: "0",
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

  test("clientSeq is gap-free when targeted events create seq gaps", async () => {
    // Stamp three events: two untargeted (seq 1, 3) + one with a
    // capability target (seq 2, host_bash). A process subscriber
    // does NOT match capability targeting (matchesSubscriber requires
    // type=client + matching capability), so the replay filters out
    // seq 2. The subscriber receives seq 1 and 3 — a gap in raw seq
    // — but clientSeq is 1, 2 — gap-free.
    const { conversationId } = getOrCreateConversation("clientseq-gap");

    stampAndBuffer(buildAssistantEvent({ type: "pong" }, conversationId));
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, conversationId), {
      targeting: { targetCapability: "host_bash" },
    });
    stampAndBuffer(buildAssistantEvent({ type: "pong" }, conversationId));

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents({
      queryParams: {
        conversationKey: "clientseq-gap",
        lastSeenSeq: "0",
      },
      abortSignal: ac.signal,
    });

    const reader = stream.getReader();

    // seq 2 (host_bash-targeted) is filtered out by replay.
    // Only seq 1 and 3 are delivered, with gap-free clientSeq.
    const f1 = await readFrame(reader);
    expect(f1).toContain('"seq":1');
    expect(f1).toContain('"clientSeq":1');

    const f2 = await readFrame(reader);
    expect(f2).toContain('"seq":3');
    expect(f2).toContain('"clientSeq":2');

    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    ac.abort();
  });

  test("live callback includes clientSeq on conversation-scoped events", async () => {
    const { conversationId } = getOrCreateConversation("clientseq-live");

    const ac = new AbortController();
    const { AssistantEventHub } =
      await import("../runtime/assistant-event-hub.js");
    const testHub = new AssistantEventHub();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: { conversationKey: "clientseq-live" },
        abortSignal: ac.signal,
      },
      { hub: testHub },
    );

    const reader = stream.getReader();

    // Drain the initial heartbeat.
    const heartbeat = await readFrame(reader);
    expect(heartbeat).toBe(": heartbeat\n\n");

    // Publish two live events with seq via stampAndBuffer.
    const e1 = buildAssistantEvent({ type: "pong" }, conversationId);
    const e2 = buildAssistantEvent({ type: "pong" }, conversationId);
    stampAndBuffer(e1);
    stampAndBuffer(e2);
    await testHub.publish(e1);
    await testHub.publish(e2);

    const f1 = await readFrame(reader);
    expect(f1).toContain('"seq":1');
    expect(f1).toContain('"clientSeq":1');

    const f2 = await readFrame(reader);
    expect(f2).toContain('"seq":2');
    expect(f2).toContain('"clientSeq":2');

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
