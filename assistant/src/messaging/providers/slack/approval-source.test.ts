import { describe, expect, mock, test } from "bun:test";

// Spread the actual modules so transitive importers of names these
// factories do not stub keep resolving (a partial factory breaks at
// import time when the graph gains a new named import).
const actualDeliveryCrud =
  await import("../../../persistence/delivery-crud.js");
const actualBindingStore =
  await import("../../../persistence/external-conversation-store.js");

let bindingRow: {
  sourceChannel: string;
  externalChatId: string;
  externalChatName: string | null;
  conversationId: string;
} | null = null;

mock.module("../../../persistence/delivery-crud.js", () => ({
  ...actualDeliveryCrud,
  getLatestInboundEventReference: () => null,
}));

mock.module("../../../persistence/external-conversation-store.js", () => ({
  ...actualBindingStore,
  getBindingByConversation: () => bindingRow,
}));

const { resolveSlackApprovalSource } = await import("./approval-source.js");

const HINT = {
  requesterChatId: "C0123CHANNEL",
  sourceMessageId: "1700000000.000100",
};

describe("resolveSlackApprovalSource chat names", () => {
  test("the binding's chat name rides the reference", () => {
    bindingRow = {
      sourceChannel: "slack",
      externalChatId: "C0123CHANNEL",
      externalChatName: "user-feedback",
      conversationId: "conv-1",
    };
    const reference = resolveSlackApprovalSource("conv-1", HINT);
    expect(reference?.sourceChatId).toBe("C0123CHANNEL");
    expect(reference?.sourceChatName).toBe("user-feedback");
  });

  test("a binding for a different chat never lends its name", () => {
    bindingRow = {
      sourceChannel: "slack",
      externalChatId: "C0OTHER",
      externalChatName: "somewhere-else",
      conversationId: "conv-1",
    };
    const reference = resolveSlackApprovalSource("conv-1", HINT);
    expect(reference?.sourceChatId).toBe("C0123CHANNEL");
    expect(reference?.sourceChatName).toBeUndefined();
  });

  test("an unnamed binding leaves the reference nameless", () => {
    bindingRow = {
      sourceChannel: "slack",
      externalChatId: "C0123CHANNEL",
      externalChatName: null,
      conversationId: "conv-1",
    };
    const reference = resolveSlackApprovalSource("conv-1", HINT);
    expect(reference?.sourceChatName).toBeUndefined();
  });
});
