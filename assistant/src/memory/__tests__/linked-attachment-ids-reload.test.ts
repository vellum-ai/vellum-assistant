/**
 * Codex P2 — inline media_ref must survive a reload (DB round-trip).
 *
 * For an inline upload the attachment id is minted only after the message row
 * exists, so it is never written into the persisted message JSON — it is
 * backfilled onto the in-memory block at send time. On a conversation reload
 * from the DB the block is rebuilt from JSON and loses the id.
 *
 * This test exercises the real persistence + link path
 * (`attachInlineAttachmentToMessage` → `message_attachments`) and then the
 * reload-side rehydration (`getLinkedAttachmentIdsForMessage` +
 * `rehydrateAttachmentIds`), proving that a reloaded inline upload again carries
 * a usable `_attachmentId` — and therefore still yields a vision-perception
 * `media_ref` marker for a non-vision backbone.
 */
import { describe, expect, test } from "bun:test";

import { rehydrateAttachmentIds } from "../../agent/attachments.js";
import type { ImageContent, Message } from "../../providers/types.js";
import {
  attachInlineAttachmentToMessage,
  getLinkedAttachmentIdsForMessage,
} from "../attachments-store.js";
import { addMessage, createConversation } from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";

initializeDb();

// 1x1 transparent PNG.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("getLinkedAttachmentIdsForMessage + rehydrateAttachmentIds", () => {
  test("returns linked ids in position order and rehydrates a reloaded block", async () => {
    resetTables();
    const conv = createConversation();

    // Persist a user message WITHOUT the attachment id in its content JSON,
    // mirroring how inline uploads are stored (id is minted afterward).
    const persisted = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "two images" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
        },
      ]),
      { skipIndexing: true },
    );

    // Link two inline attachments at positions 0 and 1.
    const a0 = attachInlineAttachmentToMessage(
      persisted.id,
      0,
      "first.png",
      "image/png",
      PNG_1X1,
    );
    const a1 = attachInlineAttachmentToMessage(
      persisted.id,
      1,
      "second.png",
      "image/png",
      PNG_1X1,
    );

    // Reload side: the ordered link list comes back position-ordered.
    const ids = getLinkedAttachmentIdsForMessage(persisted.id);
    expect(ids).toEqual([a0.id, a1.id]);

    // Simulate the reloaded in-memory message (parsed from JSON, no ids), then
    // rehydrate.
    const reloaded: Message = {
      role: "user",
      content: [
        { type: "text", text: "two images" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
        },
      ],
    };
    rehydrateAttachmentIds(reloaded, ids);

    expect((reloaded.content[1] as ImageContent)._attachmentId).toBe(a0.id);
    expect((reloaded.content[2] as ImageContent)._attachmentId).toBe(a1.id);
  });

  test("returns an empty list for a message with no linked attachments", async () => {
    resetTables();
    const conv = createConversation();
    const persisted = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "no attachments" }]),
      { skipIndexing: true },
    );
    expect(getLinkedAttachmentIdsForMessage(persisted.id)).toEqual([]);
  });
});
