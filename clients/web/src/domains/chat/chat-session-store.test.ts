import { describe, expect, test } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { applyTextDelta } from "@/domains/chat/utils/stream-updaters/entity-updaters";

describe("chat-session-store — live pointer across setMessages", () => {
  test("setMessages preserves liveAssistantRowKey when the row survives, clears it when gone", () => {
    // A streaming delta sets the live pointer.
    useChatSessionStore.getState().updateMessages((e) => applyTextDelta(e, "hi", "m1"));
    expect(useChatSessionStore.getState().entities.liveAssistantRowKey).toBe("m1");

    // A bulk rebuild (tool/surface/reconcile mid-turn) that keeps the row must
    // NOT drop the live pointer, even though `rebuildFromArray` resets it.
    useChatSessionStore.getState().setMessages((prev) => [...prev]);
    expect(useChatSessionStore.getState().entities.liveAssistantRowKey).toBe("m1");

    // A bulk rebuild that drops the row clears the now-dangling pointer.
    useChatSessionStore.getState().setMessages(() => []);
    expect(useChatSessionStore.getState().entities.liveAssistantRowKey).toBeNull();
  });
});
