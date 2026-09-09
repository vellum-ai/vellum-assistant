import { describe, expect, test } from "bun:test";

import { resolveConversationLink } from "./use-feed-item-conversation-link";

describe("resolveConversationLink", () => {
  test("offers no link when the item names no conversation", () => {
    expect(
      resolveConversationLink({
        itemConversationId: null,
        enabled: true,
        isPending: false,
        isError: false,
        exists: false,
      }),
    ).toEqual({ conversationId: null, isPending: false });
  });

  test("holds the candidate id while the by-id read is in flight", () => {
    expect(
      resolveConversationLink({
        itemConversationId: "conv-xyz",
        enabled: true,
        isPending: true,
        isError: false,
        exists: false,
      }),
    ).toEqual({ conversationId: "conv-xyz", isPending: true });
  });

  test("offers the link when the conversation still exists", () => {
    expect(
      resolveConversationLink({
        itemConversationId: "conv-xyz",
        enabled: true,
        isPending: false,
        isError: false,
        exists: true,
      }),
    ).toEqual({ conversationId: "conv-xyz", isPending: false });
  });

  test("drops the link when the by-id read 404s", () => {
    expect(
      resolveConversationLink({
        itemConversationId: "conv-gone",
        enabled: true,
        isPending: false,
        isError: false,
        exists: false,
      }),
    ).toEqual({ conversationId: null, isPending: false });
  });

  test("keeps the link when the by-id read fails for any other reason", () => {
    expect(
      resolveConversationLink({
        itemConversationId: "conv-xyz",
        enabled: true,
        isPending: false,
        isError: true,
        exists: false,
      }),
    ).toEqual({ conversationId: "conv-xyz", isPending: false });
  });

  test("fetches nothing while the detail is closed", () => {
    expect(
      resolveConversationLink({
        itemConversationId: "conv-xyz",
        enabled: false,
        isPending: true,
        isError: false,
        exists: false,
      }),
    ).toEqual({ conversationId: null, isPending: false });
  });
});
