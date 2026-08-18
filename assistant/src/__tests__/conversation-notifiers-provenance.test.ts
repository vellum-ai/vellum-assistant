/**
 * The live-call question notifier persists its row after the voice turn has
 * settled. The per-turn trust field is not cleared at release, so at that
 * moment it can still hold the finished turn's actor while voice cleanup has
 * restored the conversation's resting trust. The row must carry the owner,
 * not the stale turn actor.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const added: Array<{ metadata?: Record<string, unknown> }> = [];
mock.module("../persistence/conversation-crud.js", () => ({
  addMessage: async (
    _conversationId: string,
    _role: string,
    _content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => {
    added.push({ metadata: options?.metadata });
    return { id: "msg-1", deduplicated: false };
  },
  provenanceFromTrustContext: (ctx?: { trustClass?: string }) =>
    ctx ? { provenanceTrustClass: ctx.trustClass } : {},
}));
mock.module("../calls/call-store.js", () => ({
  getCallSession: () => ({ toNumber: "+15550100" }),
}));

import { fireCallQuestionNotifier } from "../calls/call-state.js";
import { registerConversationNotifiers } from "../daemon/conversation-notifiers.js";

describe("live-call question provenance", () => {
  beforeEach(() => {
    added.length = 0;
  });

  test("a row persisted after the turn settled carries the owner, not the stale turn actor", async () => {
    registerConversationNotifiers("conv-n1", {
      emit: () => {},
      messages: [],
      // Voice cleanup restored the owner; the per-turn field still holds the
      // finished voice turn's contact.
      trustContext: {
        trustClass: "guardian",
        sourceChannel: "vellum",
      },
      currentTurnTrustContext: {
        trustClass: "trusted_contact",
        sourceChannel: "phone",
        requesterExternalUserId: "caller-1",
      },
    } as never);

    fireCallQuestionNotifier("conv-n1", "sess-1", "Which slot works?");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(added.length).toBe(1);
    expect(added[0]?.metadata?.provenanceTrustClass).toBe("guardian");
  });
});
