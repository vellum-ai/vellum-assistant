import { describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  assembleUserContentBlocks,
  offloadOversizedText,
  OVERSIZED_CONTENT_FILENAME,
  OVERSIZED_CONTENT_NOTE,
} from "./port-oversized-content.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("offloadOversizedText", () => {
  test("leaves text under the cap unchanged", async () => {
    resetTables();
    const conv = createConversation();
    const result = await offloadOversizedText("hello", {
      conversationId: conv.id,
      conversationCreatedAt: conv.createdAt,
    });
    expect(result).toEqual({ text: "hello" });
  });

  test("ports over-cap text into a workspace_ref attachment", async () => {
    resetTables();
    const conv = createConversation();
    const original = "x".repeat(32);
    const result = await offloadOversizedText(
      original,
      {
        conversationId: conv.id,
        conversationCreatedAt: conv.createdAt,
      },
      16,
    );

    expect(result.text).toBe(OVERSIZED_CONTENT_NOTE);
    expect(result.attachmentId).toBeDefined();
    expect(result.fileBlock).toMatchObject({
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: "text/plain",
        filename: OVERSIZED_CONTENT_FILENAME,
        attachmentId: result.attachmentId,
      },
    });
    expect(JSON.stringify(result)).not.toContain(original);

    const blocks = assembleUserContentBlocks(result.text, [], result.fileBlock);
    expect(JSON.stringify(blocks)).not.toContain(original);
    expect(blocks[0]).toEqual({ type: "text", text: OVERSIZED_CONTENT_NOTE });
    expect(blocks[1]).toEqual(result.fileBlock);
  });
});
