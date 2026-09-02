import { describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  assembleUserContentBlocks,
  offloadLinkPlan,
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
    if (result.fileBlock === undefined) {
      throw new Error("expected an offloaded file block");
    }

    const blocks = assembleUserContentBlocks(result.text, [], result.fileBlock);
    expect(JSON.stringify(blocks)).not.toContain(original);
    expect(blocks[0]).toEqual({ type: "text", text: OVERSIZED_CONTENT_NOTE });
    expect(blocks[1]).toEqual(result.fileBlock);
  });
});

describe("offloadLinkPlan", () => {
  test("same persist and live id is linked and model-facing", () => {
    const plan = offloadLinkPlan("att-1", "att-1");
    expect(plan.linkIds).toEqual(["att-1"]);
    expect([...plan.modelFacingIds]).toEqual(["att-1"]);
  });

  test("display-only persist offload is linked but not model-facing", () => {
    const plan = offloadLinkPlan("att-display", undefined);
    expect(plan.linkIds).toEqual(["att-display"]);
    expect(plan.modelFacingIds.size).toBe(0);
  });

  test("distinct persist and live ids keep only live model-facing", () => {
    const plan = offloadLinkPlan("att-display", "att-live");
    expect(plan.linkIds).toEqual(["att-display", "att-live"]);
    expect([...plan.modelFacingIds]).toEqual(["att-live"]);
  });
});
