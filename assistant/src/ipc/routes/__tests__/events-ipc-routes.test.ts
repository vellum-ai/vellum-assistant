import { afterEach, describe, expect, test } from "bun:test";

import { assistantEventHub } from "../../../runtime/assistant-event-hub.js";
import {
  EVENTS_PUBLISH_IPC_METHOD,
  handleEventsPublish,
} from "../events-ipc-routes.js";

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

    const result = await handleEventsPublish({
      body: { event: fullEvent({ type: "test_event", value: 42 }) },
    });

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect((received[0] as { id: string }).id).toBe("evt-1");
    expect((received[0] as { message: unknown }).message).toEqual({
      type: "test_event",
      value: 42,
    });
  });

  test("rejects an incomplete envelope (missing id)", async () => {
    const received = subscribe();

    await expect(
      handleEventsPublish({
        body: {
          event: {
            emittedAt: "2026-07-21T00:00:00.000Z",
            message: { type: "test_event" },
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
