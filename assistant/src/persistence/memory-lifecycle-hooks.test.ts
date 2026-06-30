import { afterEach, describe, expect, test } from "bun:test";

import {
  getMemoryPersistenceHooks,
  type MemoryPersistenceHooks,
  type MessagePersistedEvent,
  registerMemoryPersistenceHooks,
  resetMemoryPersistenceHooksForTests,
} from "./memory-lifecycle-hooks.js";

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
};

describe("memory persistence-lifecycle seam", () => {
  afterEach(() => resetMemoryPersistenceHooksForTests());

  test("defaults to a no-op when no implementation is registered", async () => {
    // Resolves without throwing — the "memory not present" path.
    await getMemoryPersistenceHooks().onMessagePersisted(event);
  });

  test("getMemoryPersistenceHooks returns the registered implementation", async () => {
    const seen: MessagePersistedEvent[] = [];
    registerMemoryPersistenceHooks({
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
    registerMemoryPersistenceHooks({
      ...baseHooks,
      onMessagePersisted() {
        aCalls++;
      },
    });
    registerMemoryPersistenceHooks({
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
    registerMemoryPersistenceHooks({
      ...baseHooks,
      onMessagePersisted() {
        calls++;
      },
    });
    resetMemoryPersistenceHooksForTests();
    await getMemoryPersistenceHooks().onMessagePersisted(event);
    expect(calls).toBe(0);
  });
});
