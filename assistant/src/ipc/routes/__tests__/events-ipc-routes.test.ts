import { afterEach, describe, expect, test } from "bun:test";

import { EVENTS_PUBLISH_IPC_METHOD } from "../../../ipc/events-publish-client.js";
import { assistantEventHub } from "../../../runtime/assistant-event-hub.js";
import { handleEventsPublish } from "../events-ipc-routes.js";

describe(`${EVENTS_PUBLISH_IPC_METHOD} IPC route`, () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  });

  function subscribe(): unknown[] {
    const received: unknown[] = [];
    const sub = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });
    disposers.push(() => sub.dispose());
    return received;
  }

  function fullEvent(message: Record<string, unknown>) {
    return {
      id: "evt-1",
      emittedAt: "2026-07-21T00:00:00.000Z",
      conversationId: "conv-events-test",
      message,
    };
  }

  test("publishes a full event envelope onto the daemon hub", async () => {
    const received = subscribe();

    const message = {
      type: "generation_cancelled",
      conversationId: "conv-events-test",
    };
    const result = await handleEventsPublish({
      body: { event: fullEvent(message) },
    });

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect((received[0] as { id: string }).id).toBe("evt-1");
    expect((received[0] as { message: unknown }).message).toEqual(message);
  });

  test("stamps a forwarded conversation-scoped event with a seq for replay", async () => {
    const received = subscribe();

    // A forwarded event arrives unstamped (the worker that produced it has seq
    // stamping disabled). The daemon boundary must assign a `seq` so the event
    // takes a slot in the SSE replay ring and reconnecting clients see it in
    // order, rather than a gap.
    const event = fullEvent({
      type: "generation_cancelled",
      conversationId: "conv-events-test",
    });
    expect((event as { seq?: number }).seq).toBeUndefined();

    await handleEventsPublish({ body: { event } });

    expect(received).toHaveLength(1);
    expect(typeof (received[0] as { seq?: unknown }).seq).toBe("number");
  });

  test("rejects a message that is not a known event type", async () => {
    const received = subscribe();

    await expect(
      handleEventsPublish({
        body: { event: fullEvent({ type: "not_a_real_event" }) },
      }),
    ).rejects.toThrow();
    expect(received).toHaveLength(0);
  });

  test("rejects an incomplete envelope (missing id)", async () => {
    const received = subscribe();

    await expect(
      handleEventsPublish({
        body: {
          event: {
            emittedAt: "2026-07-21T00:00:00.000Z",
            message: { type: "generation_cancelled" },
          },
        },
      }),
    ).rejects.toThrow();
    expect(received).toHaveLength(0);
  });

  test("rejects a body without an event", async () => {
    await expect(handleEventsPublish({ body: {} })).rejects.toThrow();
  });
});
