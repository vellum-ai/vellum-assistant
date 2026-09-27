import { expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import {
  addMessage,
  createConversation,
  getRecentConversationMessages,
} from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";

await initializeDb();

test("recent conversation rows preserve insertion order at timestamp ties and stay bounded", async () => {
  const conversation = createConversation({ title: "Example task" });
  const other = createConversation({ title: "Other task" });
  const first = await addMessage(conversation.id, "user", "Start work");
  const success = await addMessage(
    conversation.id,
    "assistant",
    "The result is ready",
  );
  const failure = await addMessage(conversation.id, "user", "A sibling failed");
  await addMessage(other.id, "assistant", "Unrelated result");
  getDb().run(
    sql`UPDATE messages SET created_at = 100 WHERE conversation_id = ${conversation.id}`,
  );

  expect(
    getRecentConversationMessages(conversation.id, 2).map((row) => row.id),
  ).toEqual([success.id, failure.id]);
  expect(
    getRecentConversationMessages(conversation.id, 3).map((row) => row.id),
  ).toEqual([first.id, success.id, failure.id]);
  expect(
    getRecentConversationMessages(conversation.id, 2, failure.id).map(
      (row) => row.id,
    ),
  ).toEqual([first.id, success.id]);
});
