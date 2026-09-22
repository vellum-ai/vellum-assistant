/**
 * The `message-deleted` hook is dispatched by every primitive that removes
 * individual message rows, carrying each row's `(createdAt, id)`, so a plugin
 * keeping a cursor on a row learns where it sat once the row is gone.
 * DB-backed: exercises the real delete primitives against the test database.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { registerPluginHooks } from "../hooks/registry.js";
import type { MessageDeletedContext } from "../hooks/types.js";
import {
  addMessage,
  deleteLastExchange,
  deleteMessageById,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";
import type { PluginHooks } from "../plugins/types.js";

await initializeDb();

const CONV_ID = "conv-message-deleted-hook";

const received: Array<{
  conversationId: string;
  messageId: string;
  createdAt: number;
}> = [];
registerPluginHooks("test-message-deleted-spy", {
  "message-deleted": async (ctx: MessageDeletedContext) => {
    received.push({
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      createdAt: ctx.createdAt,
    });
  },
} as PluginHooks);

/** Poll until the fire-and-forget hook chain has delivered `count` calls. */
async function waitForCalls(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (received.length < count && Date.now() < deadline) {
    await Bun.sleep(10);
  }
}

const text = (t: string) => JSON.stringify([{ type: "text", text: t }]);

beforeEach(() => {
  received.length = 0;
  getDb().delete(messages).run();
  getDb().delete(conversations).run();
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id: CONV_ID,
      title: "message-deleted hook",
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "standard",
    })
    .run();
});

describe("message-deleted hook dispatch", () => {
  test("deleteMessageById dispatches once with the row's position", async () => {
    await addMessage(CONV_ID, "user", text("hello"));
    const reply = await addMessage(CONV_ID, "assistant", text("hi"));
    const replyCreatedAt = getMessages(CONV_ID).find(
      (m) => m.id === reply.id,
    )!.createdAt;

    deleteMessageById(reply.id);
    await waitForCalls(1);

    expect(received).toEqual([
      {
        conversationId: CONV_ID,
        messageId: reply.id,
        createdAt: replyCreatedAt,
      },
    ]);
  });

  test("deleteLastExchange dispatches for every row of the undone tail", async () => {
    await addMessage(CONV_ID, "user", text("first"));
    await addMessage(CONV_ID, "assistant", text("one"));
    const user2 = await addMessage(CONV_ID, "user", text("second"));
    const reply2 = await addMessage(CONV_ID, "assistant", text("two"));
    const byId = new Map(getMessages(CONV_ID).map((m) => [m.id, m.createdAt]));

    expect(deleteLastExchange(CONV_ID)).toBe(2);
    await waitForCalls(2);

    expect([...received].sort((a, b) => a.createdAt - b.createdAt)).toEqual([
      {
        conversationId: CONV_ID,
        messageId: user2.id,
        createdAt: byId.get(user2.id)!,
      },
      {
        conversationId: CONV_ID,
        messageId: reply2.id,
        createdAt: byId.get(reply2.id)!,
      },
    ]);
  });

  test("a delete of a missing row dispatches nothing", async () => {
    deleteMessageById("no-such-row");
    await Bun.sleep(50);

    expect(received).toEqual([]);
  });
});
