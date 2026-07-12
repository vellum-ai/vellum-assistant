/**
 * Guard tests for {@link postRouteConversationMessage} — the helper that lets a
 * workspace custom route inject a message into a conversation as a real turn.
 *
 * The security-relevant invariants are asserted here without a DB by stubbing
 * the two dependencies the helper touches: `processMessageInBackground` (the
 * turn sink — spied to inspect attribution) and `getConversation` (existence).
 *
 *   - Attribution is unspoofable: posts are always stamped with the dedicated
 *     `route` interface, never a human surface, and the helper exposes no way
 *     to override it.
 *   - No privilege escalation: the helper never passes a trust or auth context.
 *   - Unknown conversations are rejected (never silently created).
 *   - A per-conversation rate limit backstops runaway loops.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface ProcessCall {
  conversationId: string;
  content: string;
  options: Record<string, unknown> | undefined;
}
const processCalls: ProcessCall[] = [];
let conversationExists = true;

const realProcess = await import("../process-message.js");
mock.module("../process-message.js", () => ({
  ...realProcess,
  processMessageInBackground: async (
    conversationId: string,
    content: string,
    options?: Record<string, unknown>,
  ) => {
    processCalls.push({ conversationId, content, options });
    return { messageId: `msg-${processCalls.length}` };
  },
}));

const realCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getConversation: (id: string) =>
    conversationExists ? ({ id } as unknown) : null,
}));

// Controls for the active-conversation (busy/queue) path.
let conversationBusy = false;
let enqueueResult: { queued: boolean; requestId: string; rejected?: boolean } =
  {
    queued: true,
    requestId: "queued-req",
  };
const enqueueCalls: Array<{
  content: string;
  metadata: Record<string, unknown> | undefined;
}> = [];

const realStore = await import("../conversation-store.js");
mock.module("../conversation-store.js", () => ({
  ...realStore,
  getOrCreateConversation: async (_id: string) => ({
    isProcessing: () => conversationBusy,
    enqueueMessage: (opts: {
      content: string;
      metadata?: Record<string, unknown>;
    }) => {
      enqueueCalls.push({ content: opts.content, metadata: opts.metadata });
      return enqueueResult;
    },
  }),
}));

const { postRouteConversationMessage } =
  await import("../route-conversation-post.js");

const HUMAN_INTERFACES = ["web", "macos", "ios", "cli"];

describe("postRouteConversationMessage", () => {
  beforeEach(() => {
    processCalls.length = 0;
    conversationExists = true;
    conversationBusy = false;
    enqueueCalls.length = 0;
    enqueueResult = { queued: true, requestId: "queued-req" };
  });

  test("posts the turn attributed to the route interface, never a human one", async () => {
    const res = await postRouteConversationMessage(
      "conv-attr",
      "deploy finished",
    );
    expect(res.messageId).toBeTruthy();
    expect(processCalls).toHaveLength(1);
    expect(processCalls[0]!.conversationId).toBe("conv-attr");
    expect(processCalls[0]!.content).toBe("deploy finished");
    expect(processCalls[0]!.options?.sourceInterface).toBe("route");
    expect(HUMAN_INTERFACES).not.toContain(
      processCalls[0]!.options?.sourceInterface,
    );
  });

  test("never passes a trust or auth context (no privilege escalation)", async () => {
    await postRouteConversationMessage("conv-trust", "hi");
    expect(processCalls[0]!.options).not.toHaveProperty("trustContext");
    expect(processCalls[0]!.options).not.toHaveProperty("authContext");
  });

  test("rejects an unknown conversation without creating one", async () => {
    conversationExists = false;
    await expect(
      postRouteConversationMessage("does-not-exist", "hi"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(processCalls).toHaveLength(0);
  });

  test("rejects empty text", async () => {
    await expect(
      postRouteConversationMessage("conv-empty", "   "),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(processCalls).toHaveLength(0);
  });

  test("rate-limits per conversation to backstop runaway loops", async () => {
    const convId = "conv-rate-limit";
    for (let i = 0; i < 5; i++) {
      await postRouteConversationMessage(convId, `m${i}`);
    }
    await expect(
      postRouteConversationMessage(convId, "overflow"),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(processCalls).toHaveLength(5);
  });

  test("queues (does not drop) when the conversation is mid-turn", async () => {
    conversationBusy = true;
    const res = await postRouteConversationMessage("conv-busy", "event fired");
    // Queued, not processed immediately, and never dropped.
    expect(res.messageId).toBeTruthy();
    expect(enqueueCalls).toHaveLength(1);
    expect(processCalls).toHaveLength(0);
    // Queued turn keeps the route attribution via metadata.
    expect(enqueueCalls[0]!.metadata?.userMessageInterface).toBe("route");
    expect(enqueueCalls[0]!.metadata?.assistantMessageInterface).toBe("route");
    expect(HUMAN_INTERFACES).not.toContain(
      enqueueCalls[0]!.metadata?.userMessageInterface,
    );
  });

  test("surfaces a rate_limited error when the turn queue is full", async () => {
    conversationBusy = true;
    enqueueResult = { queued: false, requestId: "x", rejected: true };
    await expect(
      postRouteConversationMessage("conv-busy", "event"),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(processCalls).toHaveLength(0);
  });
});
