import { describe, expect, test } from "bun:test";

import { EventBus, EventBusDisposedError } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";

describe("EventBus", () => {
  test("emits typed events to direct listeners in registration order", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const seen: string[] = [];

    bus.on("tool.execution.started", (event) => {
      seen.push(`first:${event.toolName}`);
    });
    bus.on("tool.execution.started", async (event) => {
      await Promise.resolve();
      seen.push(`second:${event.conversationId}`);
    });

    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      toolName: "bash",
      input: { command: "ls" },
      startedAtMs: Date.now(),
    });

    expect(seen).toEqual(["first:bash", "second:conv-1"]);
  });

  test("supports onAny listeners with event envelopes", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let seenType = "";
    let seenConversationId = "";

    bus.onAny((event) => {
      seenType = event.type;
      if (event.type === "daemon.session.created") {
        seenConversationId = event.payload.conversationId;
      }
      expect(typeof event.emittedAtMs).toBe("number");
    });

    await bus.emit("daemon.session.created", {
      conversationId: "conv-2",
      createdAtMs: Date.now(),
    });

    expect(seenType).toBe("daemon.session.created");
    expect(seenConversationId).toBe("conv-2");
  });

  test("invokes direct listeners before onAny listeners for each emission", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const seen: string[] = [];

    bus.on("tool.permission.decided", async () => {
      await Promise.resolve();
      seen.push("direct-1");
    });
    bus.on("tool.permission.decided", () => {
      seen.push("direct-2");
    });
    bus.onAny((event) => {
      if (event.type === "tool.permission.decided") {
        seen.push("any");
      }
    });

    await bus.emit("tool.permission.decided", {
      conversationId: "conv-2",
      toolName: "bash",
      decision: "allow",
      riskLevel: "medium",
      decidedAtMs: Date.now(),
    });

    expect(seen).toEqual(["direct-1", "direct-2", "any"]);
  });

  test("subscription disposal is idempotent and prevents future callbacks", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let calls = 0;

    const sub = bus.on("daemon.lifecycle.stopped", () => {
      calls += 1;
    });

    sub.dispose();
    sub.dispose();

    await bus.emit("daemon.lifecycle.stopped", {
      stoppedAtMs: Date.now(),
    });

    expect(calls).toBe(0);
    expect(sub.active).toBe(false);
  });

  test("same callback can be subscribed independently", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let calls = 0;

    const listener = () => {
      calls += 1;
    };

    const first = bus.on("daemon.lifecycle.stopped", listener);
    const second = bus.on("daemon.lifecycle.stopped", listener);

    expect(bus.listenerCount("daemon.lifecycle.stopped")).toBe(2);
    first.dispose();
    expect(first.active).toBe(false);
    expect(second.active).toBe(true);

    await bus.emit("daemon.lifecycle.stopped", { stoppedAtMs: Date.now() });
    expect(calls).toBe(1);

    second.dispose();
    await bus.emit("daemon.lifecycle.stopped", { stoppedAtMs: Date.now() });
    expect(calls).toBe(1);
  });

  test("dispose clears listeners and rejects new registrations/emits", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const sub = bus.on("daemon.lifecycle.started", () => {});
    const anySub = bus.onAny(() => {});

    expect(bus.listenerCount("daemon.lifecycle.started")).toBe(1);
    expect(bus.anyListenerCount()).toBe(1);

    bus.dispose();

    expect(bus.listenerCount()).toBe(0);
    expect(bus.anyListenerCount()).toBe(0);
    expect(sub.active).toBe(false);
    expect(anySub.active).toBe(false);

    expect(() => bus.on("daemon.lifecycle.started", () => {})).toThrow(
      EventBusDisposedError,
    );
    expect(() => bus.onAny(() => {})).toThrow(EventBusDisposedError);
    await expect(
      bus.emit("daemon.lifecycle.started", {
        pid: 1,
        startedAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(EventBusDisposedError);
  });

  test("emit continues after listener failures and throws AggregateError", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let ranAfterFailure = false;

    bus.on("tool.execution.finished", () => {
      throw new Error("listener failed");
    });
    bus.on("tool.execution.finished", () => {
      ranAfterFailure = true;
    });

    await expect(
      bus.emit("tool.execution.finished", {
        conversationId: "conv-3",
        toolName: "file_read",
        decision: "allow",
        riskLevel: "low",
        isError: false,
        durationMs: 12,
        finishedAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(ranAfterFailure).toBe(true);
  });

  test("emit aggregates direct and onAny listener failures while still invoking remaining listeners", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let directRanAfterFailure = false;
    let anyRanAfterFailure = false;

    bus.on("tool.execution.failed", () => {
      throw new Error("direct listener failed");
    });
    bus.on("tool.execution.failed", () => {
      directRanAfterFailure = true;
    });
    bus.onAny((event) => {
      if (event.type === "tool.execution.failed") {
        throw new Error("any listener failed");
      }
    });
    bus.onAny((event) => {
      if (event.type === "tool.execution.failed") {
        anyRanAfterFailure = true;
      }
    });

    let caught: unknown;
    try {
      await bus.emit("tool.execution.failed", {
        conversationId: "conv-4",
        toolName: "bash",
        decision: "error",
        riskLevel: "high",
        durationMs: 31,
        error: "boom",
        isExpected: false,
        failedAtMs: Date.now(),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    const messages = aggregate.errors.map((err) =>
      err instanceof Error ? err.message : String(err),
    );
    expect(messages).toEqual(["direct listener failed", "any listener failed"]);
    expect(directRanAfterFailure).toBe(true);
    expect(anyRanAfterFailure).toBe(true);
  });
});
