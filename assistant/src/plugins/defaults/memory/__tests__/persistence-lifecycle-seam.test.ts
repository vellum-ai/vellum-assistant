import { afterEach, describe, expect, test } from "bun:test";

import { memoryPersistenceHooks } from "../persistence-hooks.js";
import {
  getMemoryPersistenceHooks,
  type MemoryPersistenceHooks,
  type MessagePersistedEvent,
  registerMemoryPersistenceHooks,
  resetMemoryPersistenceHooksForTests,
  setMemoryPersistenceHooksForTests,
} from "../persistence-lifecycle-seam.js";

const event: MessagePersistedEvent = {
  messageId: "msg-1",
  conversationId: "conv-1",
  role: "user",
  content: "[]",
  createdAt: 0,
};

/** No-op base so each stub only overrides the method it exercises. */
const baseHooks: MemoryPersistenceHooks = {
  onMessagePersisted() {},
  onConversationForked() {},
  onConversationWiped() {
    return 0;
  },
  onConversationDeleted() {},
  onMessagesDeleted() {},
  async onAllConversationsCleared() {},
};

describe("memory persistence-lifecycle seam", () => {
  afterEach(() => resetMemoryPersistenceHooksForTests());

  test("defaults to a no-op when no implementation is registered", async () => {
    // Resolves without throwing — the "memory not present" path.
    await getMemoryPersistenceHooks().onMessagePersisted(event);
  });

  test("registerMemoryPersistenceHooks installs the plugin's implementation", () => {
    registerMemoryPersistenceHooks();
    expect(getMemoryPersistenceHooks()).toBe(memoryPersistenceHooks);
  });

  test("getMemoryPersistenceHooks returns the registered implementation", async () => {
    const seen: MessagePersistedEvent[] = [];
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      onMessagePersisted(ev) {
        seen.push(ev);
      },
    });
    await getMemoryPersistenceHooks().onMessagePersisted(event);
    expect(seen).toEqual([event]);
  });

  test("registration replaces the prior implementation", async () => {
    let aCalls = 0;
    let bCalls = 0;
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      onMessagePersisted() {
        aCalls++;
      },
    });
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      onMessagePersisted() {
        bCalls++;
      },
    });
    await getMemoryPersistenceHooks().onMessagePersisted(event);
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
  });

  test("resetMemoryPersistenceHooksForTests restores the no-op", async () => {
    let calls = 0;
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      onMessagePersisted() {
        calls++;
      },
    });
    resetMemoryPersistenceHooksForTests();
    await getMemoryPersistenceHooks().onMessagePersisted(event);
    expect(calls).toBe(0);
  });

  test("onConversationDeleted defaults to a no-op and forwards the id to the registered impl", () => {
    // No-op default — the "memory not present" path does not throw.
    getMemoryPersistenceHooks().onConversationDeleted("conv-1");

    const seen: string[] = [];
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      onConversationDeleted(id) {
        seen.push(id);
      },
    });
    getMemoryPersistenceHooks().onConversationDeleted("conv-1");
    expect(seen).toEqual(["conv-1"]);
  });

  test("onMessagesDeleted defaults to a no-op and forwards ids to the registered impl", () => {
    // No-op default — the "memory not present" path does not throw.
    getMemoryPersistenceHooks().onMessagesDeleted(["msg-a", "msg-b"]);

    const seen: string[][] = [];
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      onMessagesDeleted(ids) {
        seen.push(ids);
      },
    });
    getMemoryPersistenceHooks().onMessagesDeleted(["msg-a", "msg-b"]);
    expect(seen).toEqual([["msg-a", "msg-b"]]);
  });

  test("onAllConversationsCleared defaults to a no-op and awaits the registered impl", async () => {
    // No-op default resolves without throwing.
    await getMemoryPersistenceHooks().onAllConversationsCleared();

    let cleared = 0;
    setMemoryPersistenceHooksForTests({
      ...baseHooks,
      async onAllConversationsCleared() {
        // Yield so a non-awaiting caller would observe cleared === 0.
        await Promise.resolve();
        cleared++;
      },
    });
    await getMemoryPersistenceHooks().onAllConversationsCleared();
    expect(cleared).toBe(1);
  });
});
