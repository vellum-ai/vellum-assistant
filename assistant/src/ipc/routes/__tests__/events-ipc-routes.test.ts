import { afterEach, describe, expect, test } from "bun:test";

import { assistantEventHub } from "../../../runtime/assistant-event-hub.js";
import { ForbiddenError } from "../../../runtime/routes/errors.js";
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

  test("publishes the full event onto the daemon hub", async () => {
    const received = subscribe();
    const event = {
      message: { type: "test_event", value: 42 },
      conversationId: "conv-events-test",
    };

    const result = await handleEventsPublish({ body: { event } });

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect((received[0] as { message: unknown }).message).toEqual({
      type: "test_event",
      value: 42,
    });
  });

  test("refuses daemon-to-client host-proxy control events", async () => {
    const received = subscribe();
    const event = { message: { type: "host_bash_request" } };

    await expect(
      handleEventsPublish({ body: { event } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(received).toHaveLength(0);
  });

  test("rejects a body without an event", async () => {
    await expect(handleEventsPublish({ body: {} })).rejects.toThrow();
  });
});
