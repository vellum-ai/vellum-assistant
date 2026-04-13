import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

function makeEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    id: "evt_test",
    assistantId: "ast_1",
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

// ── Fanout ────────────────────────────────────────────────────────────────────

describe("AssistantEventHub — fanout", () => {
  test("delivers event to a single matching subscriber", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_1" }, (e) => {
      received.push(e);
    });
    await hub.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("evt_test");
  });

  test("delivers event to multiple subscribers in registration order", async () => {
    const hub = new AssistantEventHub();
    const order: string[] = [];

    hub.subscribe({ assistantId: "ast_1" }, () => {
      order.push("first");
    });
    hub.subscribe({ assistantId: "ast_1" }, () => {
      order.push("second");
    });
    hub.subscribe({ assistantId: "ast_1" }, () => {
      order.push("third");
    });

    await hub.publish(makeEvent());

    expect(order).toEqual(["first", "second", "third"]);
  });

  test("does not deliver event to subscriber for a different assistantId", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_OTHER" }, (e) => {
      received.push(e);
    });
    await hub.publish(makeEvent({ assistantId: "ast_1" }));

    expect(received).toHaveLength(0);
  });

  test("conversationId filter further restricts delivery", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_1", conversationId: "sess_A" }, (e) => {
      receivedA.push(e);
    });
    hub.subscribe({ assistantId: "ast_1", conversationId: "sess_B" }, (e) => {
      receivedB.push(e);
    });

    await hub.publish(makeEvent({ conversationId: "sess_A" }));

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  test("subscriber without conversationId filter receives all sessions for that assistant", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_1" }, (e) => {
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

  test("hasSubscribersForEvent returns true for assistant-wide subscribers", () => {
    const hub = new AssistantEventHub();
    hub.subscribe({ assistantId: "ast_1" }, () => {});

    expect(
      hub.hasSubscribersForEvent({
        assistantId: "ast_1",
        conversationId: "sess_A",
      }),
    ).toBe(true);
  });

  test("hasSubscribersForEvent honors conversation scoping", () => {
    const hub = new AssistantEventHub();
    hub.subscribe({ assistantId: "ast_1", conversationId: "sess_A" }, () => {});

    expect(
      hub.hasSubscribersForEvent({
        assistantId: "ast_1",
        conversationId: "sess_A",
      }),
    ).toBe(true);
    expect(
      hub.hasSubscribersForEvent({
        assistantId: "ast_1",
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

    const sub = hub.subscribe({ assistantId: "ast_1" }, (e) => {
      received.push(e);
    });
    await hub.publish(makeEvent());
    expect(received).toHaveLength(1);

    sub.dispose();
    await hub.publish(makeEvent());
    expect(received).toHaveLength(1); // no new events
  });

  test("dispose is idempotent", () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({ assistantId: "ast_1" }, () => {});

    sub.dispose();
    sub.dispose(); // must not throw
    expect(sub.active).toBe(false);
  });

  test("active reflects subscription state", () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({ assistantId: "ast_1" }, () => {});
    expect(sub.active).toBe(true);

    sub.dispose();
    expect(sub.active).toBe(false);
  });

  test("subscriberCount reflects live subscriptions only", () => {
    const hub = new AssistantEventHub();

    const sub1 = hub.subscribe({ assistantId: "ast_1" }, () => {});
    const sub2 = hub.subscribe({ assistantId: "ast_1" }, () => {});
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

    const sub1 = hub.subscribe({ assistantId: "ast_1" }, (e) => {
      received1.push(e);
    });
    hub.subscribe({ assistantId: "ast_1" }, (e) => {
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

    hub.subscribe({ assistantId: "ast_1" }, () => {
      throw new Error("subscriber boom");
    });
    hub.subscribe({ assistantId: "ast_1" }, () => {
      secondCalled = true;
    });

    await expect(hub.publish(makeEvent())).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(secondCalled).toBe(true);
  });

  test("all subscriber errors are collected into AggregateError", async () => {
    const hub = new AssistantEventHub();

    hub.subscribe({ assistantId: "ast_1" }, () => {
      throw new Error("err-1");
    });
    hub.subscribe({ assistantId: "ast_1" }, () => {
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

    hub.subscribe({ assistantId: "ast_1" }, async () => {
      throw new Error("async-err");
    });
    hub.subscribe({ assistantId: "ast_1" }, () => {
      syncRan = true;
    });

    const caught = await hub.publish(makeEvent()).catch((e) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBeInstanceOf(Error);
    expect(syncRan).toBe(true);
  });

  test("publish resolves when all subscribers succeed", async () => {
    const hub = new AssistantEventHub();
    hub.subscribe({ assistantId: "ast_1" }, () => {});
    await expect(hub.publish(makeEvent())).resolves.toBeUndefined();
  });
});

// ── Re-entrancy (snapshot isolation) ─────────────────────────────────────────

describe("AssistantEventHub — re-entrancy / snapshot isolation", () => {
  test("subscriber added during publish does not receive the in-flight event", async () => {
    const hub = new AssistantEventHub();
    const lateReceived: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_1" }, () => {
      // Add a new subscriber mid-fanout
      hub.subscribe({ assistantId: "ast_1" }, (e) => {
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
    let sub: ReturnType<typeof hub.subscribe>;

    // eslint-disable-next-line prefer-const
    sub = hub.subscribe({ assistantId: "ast_1" }, () => {
      sub.dispose();
    });
    hub.subscribe({ assistantId: "ast_1" }, (e) => {
      received.push(e);
    });

    await hub.publish(makeEvent());
    expect(received).toHaveLength(1);
  });
});

// ── Ring buffer ──────────────────────────────────────────────────────────────

describe("AssistantEventHub — ring buffer", () => {
  test("publish appends events to the per-conversation buffer", async () => {
    const hub = new AssistantEventHub();
    const evt = makeEvent({ id: "evt_buf_1", conversationId: "conv_A" });
    await hub.publish(evt);

    const replayed = hub.getEventsSince("conv_A", "nonexistent");
    // "nonexistent" id not in buffer → empty
    expect(replayed).toHaveLength(0);

    // But using a real checkpoint should work.
    const evt2 = makeEvent({ id: "evt_buf_2", conversationId: "conv_A" });
    await hub.publish(evt2);
    const after1 = hub.getEventsSince("conv_A", "evt_buf_1");
    expect(after1).toHaveLength(1);
    expect(after1[0].id).toBe("evt_buf_2");
  });

  test("buffer trims to capacity", async () => {
    const hub = new AssistantEventHub({ eventBufferCapacity: 3 });
    for (let i = 1; i <= 5; i++) {
      await hub.publish(
        makeEvent({ id: `evt_${i}`, conversationId: "conv_trim" }),
      );
    }

    // Buffer should only contain last 3 events (3, 4, 5).
    // Asking for events since evt_2 should fail (evt_2 was evicted).
    const sinceEvicted = hub.getEventsSince("conv_trim", "evt_2");
    expect(sinceEvicted).toHaveLength(0);

    // Asking for events since evt_3 should return 4 and 5.
    const since3 = hub.getEventsSince("conv_trim", "evt_3");
    expect(since3).toHaveLength(2);
    expect(since3[0].id).toBe("evt_4");
    expect(since3[1].id).toBe("evt_5");
  });

  test("getEventsSince returns events in publish order", async () => {
    const hub = new AssistantEventHub();
    await hub.publish(makeEvent({ id: "a", conversationId: "conv_order" }));
    await hub.publish(makeEvent({ id: "b", conversationId: "conv_order" }));
    await hub.publish(makeEvent({ id: "c", conversationId: "conv_order" }));

    const after_a = hub.getEventsSince("conv_order", "a");
    expect(after_a.map((e) => e.id)).toEqual(["b", "c"]);
  });

  test("getEventsSince with null lastEventId returns empty", async () => {
    const hub = new AssistantEventHub();
    await hub.publish(makeEvent({ id: "x", conversationId: "conv_null" }));

    expect(hub.getEventsSince("conv_null", null)).toHaveLength(0);
  });

  test("system events with no conversationId are not buffered", async () => {
    const hub = new AssistantEventHub();
    await hub.publish(makeEvent({ id: "sys_1", conversationId: undefined }));

    expect(hub.bufferedConversationCount()).toBe(0);
  });

  test("onConversationDeleted removes the buffer", async () => {
    const hub = new AssistantEventHub();
    await hub.publish(makeEvent({ id: "del_1", conversationId: "conv_del" }));
    expect(hub.bufferedConversationCount()).toBe(1);

    hub.onConversationDeleted("conv_del");
    expect(hub.bufferedConversationCount()).toBe(0);
    expect(hub.getEventsSince("conv_del", "del_1")).toHaveLength(0);
  });

  test("conversation buffer LRU evicts oldest when cap reached", async () => {
    const hub = new AssistantEventHub({ maxBufferedConversations: 2 });

    await hub.publish(makeEvent({ id: "e1", conversationId: "conv_1" }));
    await hub.publish(makeEvent({ id: "e2", conversationId: "conv_2" }));
    expect(hub.bufferedConversationCount()).toBe(2);

    // Publishing to a third conversation should evict conv_1.
    await hub.publish(makeEvent({ id: "e3", conversationId: "conv_3" }));
    expect(hub.bufferedConversationCount()).toBe(2);

    // conv_1 was evicted.
    expect(hub.getEventsSince("conv_1", "e1")).toHaveLength(0);
    // conv_2 and conv_3 remain.
    expect(hub.getEventsSince("conv_2", "e2")).toHaveLength(0); // no events after e2
    expect(hub.getEventsSince("conv_3", "e3")).toHaveLength(0); // no events after e3
  });
});
