import { describe, expect, mock, test } from "bun:test";

const published: Array<{ type: string; conversationId: string | undefined }> =
  [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: { type: string }, conversationId?: string) => {
    published.push({ type: msg.type, conversationId });
  },
}));

const { conversationEventSink } =
  await import("../daemon/conversation-event-sink.js");

/**
 * The scoping guarantee the hub depends on: attribution comes from the
 * emitting conversation, so an event carrying no conversation of its own is
 * still filtered, seq-stamped and replayed like every other one.
 */
describe("conversationEventSink", () => {
  test("scopes an event whose payload names no conversation", () => {
    published.length = 0;

    conversationEventSink("conv-parent")({
      type: "subagent_status_changed",
      subagentId: "sa-1",
      status: "running",
    } as never);

    expect(published).toEqual([
      { type: "subagent_status_changed", conversationId: "conv-parent" },
    ]);
  });

  test("scopes every event to the emitting conversation, not the payload's", () => {
    published.length = 0;
    const sink = conversationEventSink("conv-parent");

    sink({ type: "subagent_spawned", subagentId: "sa-1" } as never);
    sink({
      type: "subagent_event",
      subagentId: "sa-1",
      conversationId: "conv-parent",
    } as never);

    expect(published.map((p) => p.conversationId)).toEqual([
      "conv-parent",
      "conv-parent",
    ]);
  });
});
