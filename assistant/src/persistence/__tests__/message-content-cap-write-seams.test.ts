/**
 * Tests that every message-content write seam bounds what it stores.
 *
 * The cap is enforced at persistence because that is the last boundary before
 * a body becomes permanent: in-flight truncation only protects the turn that
 * produces the content, while a stored oversized row is replayed on every
 * later turn and makes the whole conversation unsendable.
 */

import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  addMessage,
  createConversation,
  finalizeMessageContent,
  reserveMessage,
  updateMessageContent,
} from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  MAX_PERSISTED_MESSAGE_BYTES,
  messageContentBytes,
} from "../message-content-cap.js";
import { messages } from "../schema/index.js";

await initializeDb();

/** The incident shape: a ~50 MB scanner result written whole into history. */
const FIFTY_MB = 50_000_000;

/**
 * Building and storing a 50 MB body takes far longer than the default per-test
 * budget on a loaded CI runner.
 */
const OVERSIZED_WRITE_TIMEOUT_MS = 60_000;

function oversizedToolResult(): string {
  return JSON.stringify([
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "S".repeat(FIFTY_MB),
    },
  ]);
}

function storedContent(messageId: string): string {
  return getDb()
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()!.content;
}

describe("persisted message size cap at the write seams", () => {
  test(
    "an inserted 50 MB message is stored trimmed, not dropped",
    async () => {
      /**
       * Tests the insert seam: the row survives so a paired tool_use is not
       * orphaned, and what lands is small enough for a provider to accept.
       */

      // GIVEN a conversation
      const conversation = await createConversation({ title: "Insert seam" });

      // WHEN a 50 MB tool result is inserted
      const message = await addMessage(
        conversation.id,
        "user",
        oversizedToolResult(),
      );

      // THEN the row exists with content under the cap
      const stored = storedContent(message.id);
      expect(messageContentBytes(stored)).toBeLessThanOrEqual(
        MAX_PERSISTED_MESSAGE_BYTES,
      );

      // AND it is still the tool_result its tool_use is paired with
      expect(JSON.parse(stored)).toMatchObject([
        { type: "tool_result", tool_use_id: "toolu_1" },
      ]);
    },
    OVERSIZED_WRITE_TIMEOUT_MS,
  );

  test(
    "an in-place content update cannot grow a row past the cap",
    async () => {
      /** Tests the update seam used by consolidation and channel edits. */

      // GIVEN a persisted small message
      const conversation = await createConversation({ title: "Update seam" });
      const message = await addMessage(
        conversation.id,
        "user",
        JSON.stringify([{ type: "text", text: "small" }]),
      );

      // WHEN it is updated with a 50 MB body
      updateMessageContent(message.id, oversizedToolResult());

      // THEN what is stored is under the cap
      expect(
        messageContentBytes(storedContent(message.id)),
      ).toBeLessThanOrEqual(MAX_PERSISTED_MESSAGE_BYTES);
    },
    OVERSIZED_WRITE_TIMEOUT_MS,
  );

  test(
    "finalizing a streamed message caps the content it folds inline",
    async () => {
      /**
       * Tests the finalize seam: a streaming row stores a small pointer while
       * in flight, so the oversized body only reaches the row at finalize.
       */

      // GIVEN a reserved streaming row
      const conversation = await createConversation({ title: "Finalize seam" });
      const message = await reserveMessage(conversation.id, "assistant");

      // WHEN it is finalized with a 50 MB body and a metadata stamp
      finalizeMessageContent(message.id, oversizedToolResult(), {
        servedModel: "gpt-5",
      });

      // THEN the finalized row is under the cap
      const row = getDb()
        .select({ content: messages.content, finalized: messages.finalized })
        .from(messages)
        .where(eq(messages.id, message.id))
        .get()!;
      expect(messageContentBytes(row.content)).toBeLessThanOrEqual(
        MAX_PERSISTED_MESSAGE_BYTES,
      );

      // AND it is still marked finalized
      expect(row.finalized).toBe(1);
    },
    OVERSIZED_WRITE_TIMEOUT_MS,
  );
});
