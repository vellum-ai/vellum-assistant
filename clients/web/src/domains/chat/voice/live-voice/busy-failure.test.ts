import { describe, expect, test } from "bun:test";

import { describeBusyFailure } from "./busy-failure";

describe("describeBusyFailure", () => {
  test("names the surface the holder is running on", () => {
    expect(describeBusyFailure({ client: "macos" }, null).message).toBe(
      "Voice is already active in the Mac app.",
    );
    expect(describeBusyFailure({ client: "web" }, null).message).toBe(
      "Voice is already active in another browser tab.",
    );
  });

  test("falls back to unplaced copy for a holder it cannot name", () => {
    // A daemon that predates the field, a client that never sent one, and a
    // value this build does not know all land in the same place.
    for (const holder of [
      undefined,
      {},
      { conversationId: "conversation-1" },
      { client: "toaster" },
    ]) {
      expect(describeBusyFailure(holder, null).message).toBe(
        "Voice is already active somewhere else.",
      );
    }
  });

  test("offers the holder's conversation when it is somewhere else", () => {
    expect(
      describeBusyFailure(
        { client: "ios", conversationId: "conversation-other" },
        "conversation-here",
      ).recovery,
    ).toEqual({ kind: "reclaim", holderConversationId: "conversation-other" });
  });

  test("offers no destination when the holder is in this conversation", () => {
    // Navigating to the conversation already on screen would be an action
    // that visibly does nothing.
    expect(
      describeBusyFailure(
        { client: "ios", conversationId: "conversation-here" },
        "conversation-here",
      ).recovery,
    ).toEqual({ kind: "reclaim", holderConversationId: null });
  });

  test("always offers to reclaim, however little it knows", () => {
    expect(describeBusyFailure(undefined, null).recovery.kind).toBe("reclaim");
  });
});
