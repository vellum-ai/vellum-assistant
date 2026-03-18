import { describe, expect, it, mock } from "bun:test";

// Mock the persistence layer so tests are isolated from the database.
// getMaxSequence returning -1 means "no persisted events" → sequence starts at 0.
mock.module("../memory/trace-event-store.js", () => ({
  getMaxSequence: () => -1,
  persistTraceEvent: () => {},
}));

import type { ServerMessage, TraceEvent } from "../daemon/message-protocol.js";
import { TraceEmitter } from "../daemon/trace-emitter.js";

function createEmitter() {
  const sent: TraceEvent[] = [];
  const sendToClient = mock((msg: ServerMessage) => {
    sent.push(msg as TraceEvent);
  });
  const emitter = new TraceEmitter("sess-1", sendToClient);
  return { emitter, sent, sendToClient };
}

describe("TraceEmitter", () => {
  it("emits a trace event with correct structure", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "Running bash");

    expect(sent).toHaveLength(1);
    const event = sent[0];
    expect(event.type).toBe("trace_event");
    expect(event.conversationId).toBe("sess-1");
    expect(event.kind).toBe("tool_started");
    expect(event.summary).toBe("Running bash");
    expect(typeof event.eventId).toBe("string");
    expect(typeof event.timestampMs).toBe("number");
    expect(event.sequence).toBe(0);
  });

  it("increments sequence monotonically", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "first");
    emitter.emit("tool_finished", "second");
    emitter.emit("message_complete", "third");

    expect(sent.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("generates unique eventIds", () => {
    const { emitter, sent } = createEmitter();
    for (let i = 0; i < 10; i++) {
      emitter.emit("tool_started", `event-${i}`);
    }
    const ids = sent.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(10);
  });

  it("truncates summary to 200 characters", () => {
    const { emitter, sent } = createEmitter();
    const longSummary = "x".repeat(300);
    emitter.emit("tool_started", longSummary);

    expect(sent[0].summary).toHaveLength(200);
    expect(sent[0].summary).toBe("x".repeat(200));
  });

  it("does not truncate summary within the limit", () => {
    const { emitter, sent } = createEmitter();
    const summary = "x".repeat(200);
    emitter.emit("tool_started", summary);

    expect(sent[0].summary).toHaveLength(200);
  });

  it("passes through requestId and status", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_finished", "Done", {
      requestId: "req-42",
      status: "success",
    });

    expect(sent[0].requestId).toBe("req-42");
    expect(sent[0].status).toBe("success");
  });

  it("normalizes primitive attribute values", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "test", {
      attributes: {
        strVal: "hello",
        numVal: 42,
        boolVal: true,
        nullVal: null,
      },
    });

    expect(sent[0].attributes).toEqual({
      strVal: "hello",
      numVal: 42,
      boolVal: true,
      nullVal: null,
    });
  });

  it("coerces undefined attribute values to null", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "test", {
      attributes: { key: undefined },
    });

    expect(sent[0].attributes).toEqual({ key: null });
  });

  it("coerces object attribute values to JSON strings", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "test", {
      attributes: { obj: { nested: true }, arr: [1, 2, 3] },
    });

    expect(sent[0].attributes!.obj).toBe('{"nested":true}');
    expect(sent[0].attributes!.arr).toBe("[1,2,3]");
  });

  it("truncates long attribute string values to 500 chars", () => {
    const { emitter, sent } = createEmitter();
    const longValue = "y".repeat(600);
    emitter.emit("tool_started", "test", {
      attributes: { big: longValue },
    });

    expect(sent[0].attributes!.big).toHaveLength(500);
  });

  it("truncates long serialized object attribute values", () => {
    const { emitter, sent } = createEmitter();
    const bigObj = { data: "z".repeat(600) };
    emitter.emit("tool_started", "test", {
      attributes: { obj: bigObj },
    });

    const val = sent[0].attributes!.obj as string;
    expect(val.length).toBeLessThanOrEqual(500);
  });

  it("handles non-serializable attribute values gracefully", () => {
    const { emitter, sent } = createEmitter();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    emitter.emit("tool_started", "test", {
      attributes: { bad: circular },
    });

    expect(sent[0].attributes!.bad).toBe("[non-serializable]");
  });

  it("omits attributes when none provided", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "test");

    expect(sent[0].attributes).toBeUndefined();
  });

  it("updateSender redirects subsequent events to the new callback", () => {
    const { emitter, sent } = createEmitter();
    emitter.emit("tool_started", "before");
    expect(sent).toHaveLength(1);

    const newSent: TraceEvent[] = [];
    const newSender = mock((msg: ServerMessage) => {
      newSent.push(msg as TraceEvent);
    });
    emitter.updateSender(newSender);

    emitter.emit("tool_finished", "after");
    // Old sender should not receive the new event
    expect(sent).toHaveLength(1);
    // New sender should receive it
    expect(newSent).toHaveLength(1);
    expect(newSent[0].summary).toBe("after");
    // Sequence continues from where it left off
    expect(newSent[0].sequence).toBe(sent[0].sequence + 1);
  });
});
