import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

function makeEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    id: "evt_test",
    conversationId: "sess_1",
    emittedAt: "2026-02-18T00:00:00.000Z",
    message: {
      type: "assistant_text_delta",
      conversationId: "sess_1",
      text: "hi",
    },
    ...overrides,
  };
}

/** Shorthand: register a process subscriber with no-op eviction. */
function sub(
  hub: AssistantEventHub,
  filter: { conversationId?: string },
  callback: (e: AssistantEvent) => void | Promise<void>,
) {
  return hub.subscribe({
    type: "process",
    filter,
    callback,
    onEvict: () => {},
  });
}

// ── Fanout ────────────────────────────────────────────────────────────────────

describe("AssistantEventHub — fanout", () => {
  test("delivers event to a single matching subscriber", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    sub(hub, {}, (e) => {
      received.push(e);
    });
    await hub.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("evt_test");
  });

  test("delivers event to multiple subscribers in registration order", async () => {
    const hub = new AssistantEventHub();
    const order: string[] = [];

    sub(hub, {}, () => {
      order.push("first");
    });
    sub(hub, {}, () => {
      order.push("second");
    });
    sub(hub, {}, () => {
      order.push("third");
    });

    await hub.publish(makeEvent());

    expect(order).toEqual(["first", "second", "third"]);
  });

  test("conversationId filter further restricts delivery", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    sub(hub, { conversationId: "sess_A" }, (e) => {
      receivedA.push(e);
    });
    sub(hub, { conversationId: "sess_B" }, (e) => {
      receivedB.push(e);
    });

    await hub.publish(makeEvent({ conversationId: "sess_A" }));

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  test("subscriber without conversationId filter receives all conversations", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    sub(hub, {}, (e) => {
      received.push(e);
    });

    await hub.publish(makeEvent({ conversationId: "sess_A" }));
    await hub.publish(makeEvent({ conversationId: "sess_B" }));
    await hub.publish(makeEvent({ conversationId: undefined }));

    expect(received).toHaveLength(3);
  });

  test("publish with no subscribers is a no-op", async () => {
    const hub = new AssistantEventHub();
    await expect(hub.publish(makeEvent())).resolves.toBeUndefined();
  });

  test("hasSubscribersForEvent returns true for unscoped subscribers", () => {
    const hub = new AssistantEventHub();
    sub(hub, {}, () => {});

    expect(
      hub.hasSubscribersForEvent({
        conversationId: "sess_A",
      }),
    ).toBe(true);
  });

  test("hasSubscribersForEvent honors conversation scoping", () => {
    const hub = new AssistantEventHub();
    sub(hub, { conversationId: "sess_A" }, () => {});

    expect(
      hub.hasSubscribersForEvent({
        conversationId: "sess_A",
      }),
    ).toBe(true);
    expect(
      hub.hasSubscribersForEvent({
        conversationId: "sess_B",
      }),
    ).toBe(false);
  });
});

// ── Unsubscribe / cleanup ────────────────────────────────────────────────────

describe("AssistantEventHub — unsubscribe cleanup", () => {
  test("dispose stops event delivery", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    const s = sub(hub, {}, (e) => {
      received.push(e);
    });
    await hub.publish(makeEvent());
    expect(received).toHaveLength(1);

    s.dispose();
    await hub.publish(makeEvent());
    expect(received).toHaveLength(1); // no new events
  });

  test("dispose is idempotent", () => {
    const hub = new AssistantEventHub();
    const s = sub(hub, {}, () => {});

    s.dispose();
    s.dispose(); // must not throw
    expect(s.active).toBe(false);
  });

  test("active reflects subscription state", () => {
    const hub = new AssistantEventHub();
    const s = sub(hub, {}, () => {});
    expect(s.active).toBe(true);

    s.dispose();
    expect(s.active).toBe(false);
  });

  test("subscriberCount reflects live subscriptions only", () => {
    const hub = new AssistantEventHub();

    const sub1 = sub(hub, {}, () => {});
    const sub2 = sub(hub, {}, () => {});
    expect(hub.subscriberCount()).toBe(2);

    sub1.dispose();
    expect(hub.subscriberCount()).toBe(1);

    sub2.dispose();
    expect(hub.subscriberCount()).toBe(0);
  });

  test("disposing one subscription does not affect others", async () => {
    const hub = new AssistantEventHub();
    const received1: AssistantEvent[] = [];
    const received2: AssistantEvent[] = [];

    const sub1 = sub(hub, {}, (e) => {
      received1.push(e);
    });
    sub(hub, {}, (e) => {
      received2.push(e);
    });

    sub1.dispose();
    await hub.publish(makeEvent());

    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);
  });
});

// ── Exception isolation ───────────────────────────────────────────────────────

describe("AssistantEventHub — exception isolation", () => {
  test("a throwing subscriber does not stop fanout to remaining subscribers", async () => {
    const hub = new AssistantEventHub();
    let secondCalled = false;

    sub(hub, {}, () => {
      throw new Error("subscriber boom");
    });
    sub(hub, {}, () => {
      secondCalled = true;
    });

    await expect(hub.publish(makeEvent())).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(secondCalled).toBe(true);
  });

  test("all subscriber errors are collected into AggregateError", async () => {
    const hub = new AssistantEventHub();

    sub(hub, {}, () => {
      throw new Error("err-1");
    });
    sub(hub, {}, () => {
      throw new Error("err-2");
    });

    const caught = await hub.publish(makeEvent()).catch((e) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors.map((e: Error) => e.message)).toEqual(["err-1", "err-2"]);
  });

  test("async subscriber rejection is caught and collected", async () => {
    const hub = new AssistantEventHub();
    let syncRan = false;

    sub(hub, {}, async () => {
      throw new Error("async-err");
    });
    sub(hub, {}, () => {
      syncRan = true;
    });

    const caught = await hub.publish(makeEvent()).catch((e) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBeInstanceOf(Error);
    expect(syncRan).toBe(true);
  });

  test("publish resolves when all subscribers succeed", async () => {
    const hub = new AssistantEventHub();
    sub(hub, {}, () => {});
    await expect(hub.publish(makeEvent())).resolves.toBeUndefined();
  });
});

// ── Re-entrancy (snapshot isolation) ─────────────────────────────────────────

describe("AssistantEventHub — re-entrancy / snapshot isolation", () => {
  test("subscriber added during publish does not receive the in-flight event", async () => {
    const hub = new AssistantEventHub();
    const lateReceived: AssistantEvent[] = [];

    sub(hub, {}, () => {
      // Add a new subscriber mid-fanout
      sub(hub, {}, (e) => {
        lateReceived.push(e);
      });
    });

    await hub.publish(makeEvent());

    // The newly added subscriber must NOT have received the in-flight event
    expect(lateReceived).toHaveLength(0);
  });

  test("subscriber that disposes itself mid-publish does not affect remaining subscribers", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];
    let s: ReturnType<typeof hub.subscribe>;

    // eslint-disable-next-line prefer-const
    s = sub(hub, {}, () => {
      s.dispose();
    });
    sub(hub, {}, (e) => {
      received.push(e);
    });

    await hub.publish(makeEvent());
    expect(received).toHaveLength(1);
  });
});
