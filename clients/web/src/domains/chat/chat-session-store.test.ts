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

describe("chat-session-store — rowKey continuity across the reconcile rebuild", () => {
  test("a nonce-born row keeps its rowKey + live pointer after adopting its server id", () => {
    useChatSessionStore.getState().setMessages(() => []); // isolate from other tests

    // A delta with no messageId opens a nonce-keyed optimistic assistant row.
    useChatSessionStore.getState().updateMessages((e) => applyTextDelta(e, "hi"));
    const nonceKey = useChatSessionStore.getState().entities.liveAssistantRowKey!;
    expect(useChatSessionStore.getState().entities.byId[nonceKey]!.id).toBe(nonceKey);

    // Completion adopts the durable server id; the rowKey is frozen at the nonce.
    useChatSessionStore
      .getState()
      .patchMessage(nonceKey, (row) => ({ ...row, id: "srv-9", isOptimistic: false }));
    expect(useChatSessionStore.getState().entities.order).toEqual([nonceKey]);

    // A reconcile / history snapshot reapplies the row (now under its server id)
    // through the bulk path. `prior` maps the server id back to the mounted nonce
    // key, so the row keeps its key (no remount) and the live pointer survives.
    useChatSessionStore.getState().setMessages((prev) => prev.map((m) => ({ ...m })));
    const after = useChatSessionStore.getState().entities;
    expect(after.order).toEqual([nonceKey]);
    expect(after.liveAssistantRowKey).toBe(nonceKey);
  });
});
