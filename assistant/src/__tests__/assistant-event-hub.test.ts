import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  AssistantEventHub,
  broadcastMessage,
  capabilityForMessageType,
} from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

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

// ── Fanout ────────────────────────────────────────────────────────────────────

describe("AssistantEventHub — fanout", () => {
  test("delivers event to a single matching subscriber", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({
      type: "process",
      callback: (e) => {
        received.push(e);
      },
    });
    await hub.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("evt_test");
  });

  test("delivers event to multiple subscribers in registration order", async () => {
    const hub = new AssistantEventHub();
    const order: string[] = [];

    hub.subscribe({
      type: "process",
      callback: () => {
        order.push("first");
      },
    });
    hub.subscribe({
      type: "process",
      callback: () => {
        order.push("second");
      },
    });
    hub.subscribe({
      type: "process",
      callback: () => {
        order.push("third");
      },
    });

    await hub.publish(makeEvent());

    expect(order).toEqual(["first", "second", "third"]);
  });

  test("conversationId filter further restricts delivery", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({
      type: "process",
      filter: { conversationId: "sess_A" },
      callback: (e) => {
        receivedA.push(e);
      },
    });
    hub.subscribe({
      type: "process",
      filter: { conversationId: "sess_B" },
      callback: (e) => {
        receivedB.push(e);
      },
    });

    await hub.publish(makeEvent({ conversationId: "sess_A" }));

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  test("subscriber without conversationId filter receives all conversations", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({
      type: "process",
      callback: (e) => {
        received.push(e);
      },
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
    hub.subscribe({ type: "process", callback: () => {} });

    expect(
      hub.hasSubscribersForEvent({
        conversationId: "sess_A",
      }),
    ).toBe(true);
  });

  test("hasSubscribersForEvent honors conversation scoping", () => {
    const hub = new AssistantEventHub();
    hub.subscribe({
      type: "process",
      filter: { conversationId: "sess_A" },
      callback: () => {},
    });

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

    const s = hub.subscribe({
      type: "process",
      callback: (e) => {
        received.push(e);
      },
    });
    await hub.publish(makeEvent());
    expect(received).toHaveLength(1);

    s.dispose();
    await hub.publish(makeEvent());
    expect(received).toHaveLength(1); // no new events
  });

  test("dispose is idempotent", () => {
    const hub = new AssistantEventHub();
    const s = hub.subscribe({ type: "process", callback: () => {} });

    s.dispose();
    s.dispose(); // must not throw
    expect(s.active).toBe(false);
  });

  test("active reflects subscription state", () => {
    const hub = new AssistantEventHub();
    const s = hub.subscribe({ type: "process", callback: () => {} });
    expect(s.active).toBe(true);

    s.dispose();
    expect(s.active).toBe(false);
  });

  test("subscriberCount reflects live subscriptions only", () => {
    const hub = new AssistantEventHub();

    const s1 = hub.subscribe({ type: "process", callback: () => {} });
    const s2 = hub.subscribe({ type: "process", callback: () => {} });
    expect(hub.subscriberCount()).toBe(2);

    s1.dispose();
    expect(hub.subscriberCount()).toBe(1);

    s2.dispose();
    expect(hub.subscriberCount()).toBe(0);
  });

  test("disposing one subscription does not affect others", async () => {
    const hub = new AssistantEventHub();
    const received1: AssistantEvent[] = [];
    const received2: AssistantEvent[] = [];

    const s1 = hub.subscribe({
      type: "process",
      callback: (e) => {
        received1.push(e);
      },
    });
    hub.subscribe({
      type: "process",
      callback: (e) => {
        received2.push(e);
      },
    });

    s1.dispose();
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

    hub.subscribe({
      type: "process",
      callback: () => {
        throw new Error("subscriber boom");
      },
    });
    hub.subscribe({
      type: "process",
      callback: () => {
        secondCalled = true;
      },
    });

    await expect(hub.publish(makeEvent())).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(secondCalled).toBe(true);
  });

  test("all subscriber errors are collected into AggregateError", async () => {
    const hub = new AssistantEventHub();

    hub.subscribe({
      type: "process",
      callback: () => {
        throw new Error("err-1");
      },
    });
    hub.subscribe({
      type: "process",
      callback: () => {
        throw new Error("err-2");
      },
    });

    const caught = await hub.publish(makeEvent()).catch((e) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors.map((e: Error) => e.message)).toEqual(["err-1", "err-2"]);
  });

  test("async subscriber rejection is caught and collected", async () => {
    const hub = new AssistantEventHub();
    let syncRan = false;

    hub.subscribe({
      type: "process",
      callback: async () => {
        throw new Error("async-err");
      },
    });
    hub.subscribe({
      type: "process",
      callback: () => {
        syncRan = true;
      },
    });

    const caught = await hub.publish(makeEvent()).catch((e) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBeInstanceOf(Error);
    expect(syncRan).toBe(true);
  });

  test("publish resolves when all subscribers succeed", async () => {
    const hub = new AssistantEventHub();
    hub.subscribe({ type: "process", callback: () => {} });
    await expect(hub.publish(makeEvent())).resolves.toBeUndefined();
  });
});

// ── Re-entrancy (snapshot isolation) ─────────────────────────────────────────

describe("AssistantEventHub — re-entrancy / snapshot isolation", () => {
  test("subscriber added during publish does not receive the in-flight event", async () => {
    const hub = new AssistantEventHub();
    const lateReceived: AssistantEvent[] = [];

    hub.subscribe({
      type: "process",
      callback: () => {
        hub.subscribe({
          type: "process",
          callback: (e) => {
            lateReceived.push(e);
          },
        });
      },
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
    s = hub.subscribe({
      type: "process",
      callback: () => {
        s.dispose();
      },
    });
    hub.subscribe({
      type: "process",
      callback: (e) => {
        received.push(e);
      },
    });

    await hub.publish(makeEvent());
    expect(received).toHaveLength(1);
  });
});

// ── capabilityForMessageType — host-prefix routing ───────────────────────────

describe("capabilityForMessageType — host-prefix routing", () => {
  test("two-segment domains map to their capability", () => {
    expect(capabilityForMessageType("host_bash_request")).toBe("host_bash");
    expect(capabilityForMessageType("host_bash_cancel")).toBe("host_bash");
    expect(capabilityForMessageType("host_file_request")).toBe("host_file");
    expect(capabilityForMessageType("host_cu_request")).toBe("host_cu");
    expect(capabilityForMessageType("host_cu_cancel")).toBe("host_cu");
    expect(capabilityForMessageType("host_browser_request")).toBe(
      "host_browser",
    );
  });

  test("host_transfer_* piggybacks on host_file capability", () => {
    expect(capabilityForMessageType("host_transfer_request")).toBe("host_file");
    expect(capabilityForMessageType("host_transfer_cancel")).toBe("host_file");
  });

  test("three-segment host_app_control routes to its own capability (longest-prefix wins)", () => {
    expect(capabilityForMessageType("host_app_control_request")).toBe(
      "host_app_control",
    );
    expect(capabilityForMessageType("host_app_control_cancel")).toBe(
      "host_app_control",
    );
  });

  test("non-host messages return undefined (broadcast)", () => {
    expect(capabilityForMessageType("assistant_text_delta")).toBeUndefined();
    expect(capabilityForMessageType("confirmation_request")).toBeUndefined();
    expect(
      capabilityForMessageType("conversation_list_invalidated"),
    ).toBeUndefined();
  });

  test("unknown host_<domain>_* prefixes return undefined", () => {
    expect(capabilityForMessageType("host_unknown_request")).toBeUndefined();
  });
});

// ── broadcastMessage — pending interaction registration ─────────────────────
//
// Host proxy interactions (host_bash, host_cu, host_file, host_browser,
// host_app_control, host_transfer) are registered in pendingInteractions by
// the proxy itself (in its request() method), not by the event hub. This
// avoids overwriting the RPC lifecycle state (rpcResolve/rpcReject/timer)
// that the proxy stores alongside conversationId/kind.
//
// confirmation_request and secret_request are also NOT registered here — the
// prompters (PermissionPrompter, SecretPrompter) self-register in their
// prompt() methods, just like the host proxies. broadcastMessage is purely a
// message-delivery mechanism; it has no registration side effects.

describe("broadcastMessage — pending interaction registration", () => {
  beforeEach(() => {
    pendingInteractions.clear();
  });

  test("does NOT register confirmation_request — PermissionPrompter self-registers", () => {
    broadcastMessage({
      type: "confirmation_request",
      requestId: "req-confirm-1",
      conversationId: "conv-1",
      toolName: "bash",
      input: { command: "rm -rf /" },
      riskLevel: "high",
      executionTarget: "sandbox",
      allowlistOptions: [],
      scopeOptions: [],
    } as never);

    expect(pendingInteractions.get("req-confirm-1")).toBeUndefined();
  });

  test("does NOT register secret_request — SecretPrompter self-registers", () => {
    broadcastMessage({
      type: "secret_request",
      requestId: "req-secret-1",
      conversationId: "conv-1",
      service: "github",
      field: "token",
    } as never);

    expect(pendingInteractions.get("req-secret-1")).toBeUndefined();
  });

  test("does NOT register host proxy requests — proxies self-register", () => {
    // host_bash, host_cu, host_file, host_browser, host_app_control, and
    // host_transfer are registered by the proxy in request(), not here.
    broadcastMessage({
      type: "host_bash_request",
      requestId: "req-bash-1",
      conversationId: "conv-1",
      command: "echo hi",
      timeout_ms: 1000,
    } as never);

    expect(pendingInteractions.get("req-bash-1")).toBeUndefined();
  });
});
