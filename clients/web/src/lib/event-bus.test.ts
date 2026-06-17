import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import {
  __resetForTesting,
  publish,
  subscribe,
} from "@/lib/event-bus";

function avatarEnvelope(): AssistantEventEnvelope {
  return {
    id: "evt-1",
    emittedAt: new Date().toISOString(),
    message: { type: "avatar_updated", avatarPath: "/tmp/avatar.png" },
  };
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  __resetForTesting();
});

describe("event-bus", () => {
  test("publish delivers to a single subscriber", () => {
    const handler = mock(() => {});
    subscribe("sse.event", handler);
    const envelope = avatarEnvelope();
    publish("sse.event", envelope);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(envelope);
  });

  test("publish delivers to every active subscriber", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    subscribe("app.online", a);
    subscribe("app.online", b);
    publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe stops delivery to that subscriber", () => {
    const handler = mock(() => {});
    const unsubscribe = subscribe("sse.event", handler);
    publish("sse.event", avatarEnvelope());
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    publish("sse.event", avatarEnvelope());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe is safe to call twice", () => {
    const handler = mock(() => {});
    const unsubscribe = subscribe("app.offline", handler);
    unsubscribe();
    unsubscribe();
    publish("app.offline", {});
    expect(handler).not.toHaveBeenCalled();
  });

  test("subscribers on different event names are isolated", () => {
    const sseHandler = mock(() => {});
    const resumeHandler = mock(() => {});
    subscribe("sse.event", sseHandler);
    subscribe("app.resume", resumeHandler);
    publish("app.resume", { signal: "visibility" });
    expect(sseHandler).not.toHaveBeenCalled();
    expect(resumeHandler).toHaveBeenCalledTimes(1);
  });

  test("publish with no subscribers is a no-op", () => {
    expect(() => publish("app.resume", { signal: "online" })).not.toThrow();
  });

  test("a throwing handler does not block downstream handlers", () => {
    const bad = mock(() => {
      throw new Error("boom");
    });
    const good = mock(() => {});
    subscribe("app.online", bad);
    subscribe("app.online", good);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      publish("app.online", {});
    } finally {
      console.error = originalConsoleError;
    }
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("unsubscribing during dispatch does not skip remaining handlers", () => {
    const a = mock(() => {});
    const c = mock(() => {});
    let unsubB: (() => void) | null = null;
    const b = mock(() => {
      unsubB?.();
    });
    subscribe("app.online", a);
    unsubB = subscribe("app.online", b);
    subscribe("app.online", c);
    publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    publish("app.online", {});
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(2);
  });

  test("sse.opened payload is typed and delivered to subscribers", () => {
    const handler = mock(() => {});
    subscribe("sse.opened", handler);
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });
    expect(handler).toHaveBeenCalledWith({
      assistantId: "asst-1",
      cause: "fresh",
    });
  });

  test("sse.closed payload is typed and delivered to subscribers", () => {
    const handler = mock(() => {});
    subscribe("sse.closed", handler);
    publish("sse.closed", { reason: "network error" });
    expect(handler).toHaveBeenCalledWith({ reason: "network error" });
  });

  test("reachability.retry-requested is delivered to subscribers", () => {
    const handler = mock(() => {});
    subscribe("reachability.retry-requested", handler);
    publish("reachability.retry-requested", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("__resetForTesting clears every subscriber", () => {
    const handler = mock(() => {});
    subscribe("app.online", handler);
    __resetForTesting();
    publish("app.online", {});
    expect(handler).not.toHaveBeenCalled();
  });

  test("subscribers fire in insertion order", () => {
    const order: string[] = [];
    subscribe("app.online", () => order.push("first"));
    subscribe("app.online", () => order.push("second"));
    subscribe("app.online", () => order.push("third"));
    publish("app.online", {});
    expect(order).toEqual(["first", "second", "third"]);
  });

  test("a subscriber registered during dispatch does NOT receive the in-flight event", () => {
    // The snapshot-on-publish invariant: handlers list is captured at
    // the start of dispatch, so subscribes that happen mid-loop only
    // take effect on the next publish.
    const late = mock(() => {});
    subscribe("app.online", () => {
      subscribe("app.online", late);
    });
    publish("app.online", {});
    expect(late).not.toHaveBeenCalled();
    publish("app.online", {});
    expect(late).toHaveBeenCalledTimes(1);
  });

  test("the same handler reference subscribed twice fires once per publish (Set dedup)", () => {
    const handler = mock(() => {});
    subscribe("app.online", handler);
    subscribe("app.online", handler);
    publish("app.online", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("unsubscribing the same handler twice only removes it once (idempotent)", () => {
    const handler = mock(() => {});
    const unsub1 = subscribe("app.online", handler);
    const unsub2 = subscribe("app.online", handler);
    // unsub1 and unsub2 close over the same handler — first call removes
    // it, second call is a no-op.
    unsub1();
    publish("app.online", {});
    expect(handler).not.toHaveBeenCalled();
    expect(() => unsub2()).not.toThrow();
  });

  test("a handler publishing the same event recursively does not skip pending subscribers", () => {
    // Snapshot semantics protect concurrent mutation, but they also
    // mean a recursive publish processes its own (independent)
    // snapshot. Verify both invocations reach every subscriber.
    const a = mock(() => {});
    const b = mock(() => {});
    let republished = false;
    subscribe("app.online", () => {
      a();
      if (!republished) {
        republished = true;
        publish("app.online", {});
      }
    });
    subscribe("app.online", b);
    publish("app.online", {});
    // First publish reaches both subscribers; the recursive publish
    // inside the first subscriber also reaches both.
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  test("unsubscribe after __resetForTesting is a safe no-op", () => {
    const handler = mock(() => {});
    const unsub = subscribe("app.online", handler);
    __resetForTesting();
    // The unsubscribe closure references the previous handler map
    // (now reassigned). It must not throw.
    expect(() => unsub()).not.toThrow();
  });

  test("publishing after reset with no subscribers is a no-op", () => {
    // Reset clears the handler registry; publishing into the empty
    // Map resolves to a no-op (the `set` lookup returns undefined
    // and the early-return fires).
    expect(() => publish("app.offline", {})).not.toThrow();
  });
});
