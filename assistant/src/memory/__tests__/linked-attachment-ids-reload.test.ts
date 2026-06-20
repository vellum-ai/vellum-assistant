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

    // Reload side: the positioned link list comes back position-ordered.
    const links = getLinkedAttachmentIdsForMessage(persisted.id);
    expect(links).toEqual([
      { position: 0, attachmentId: a0.id },
      { position: 1, attachmentId: a1.id },
    ]);

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
    rehydrateAttachmentIds(reloaded, links);

    expect((reloaded.content[1] as ImageContent)._attachmentId).toBe(a0.id);
    expect((reloaded.content[2] as ImageContent)._attachmentId).toBe(a1.id);
  });

  test("sparse: skipped first upload keeps the second id on the SECOND block", async () => {
    // Reproduces the Codex P2: a message with two media blocks where the FIRST
    // attachment was skipped at upload time (unsupported/dangerous MIME or no
    // data) so it has NO message_attachments row, and only the SECOND was
    // stored — linked at position 1, mirroring the live persist loop which keeps
    // advancing its index across the skipped upload.
    resetTables();
    const conv = createConversation();

    const persisted = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "two images, first one skipped" },
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

    // Only the SECOND attachment is stored, at position 1 (gap at position 0).
    const a1 = attachInlineAttachmentToMessage(
      persisted.id,
      1,
      "second.png",
      "image/png",
      PNG_1X1,
    );

    // The link list is sparse: a single entry at position 1, gap preserved.
    const links = getLinkedAttachmentIdsForMessage(persisted.id);
    expect(links).toEqual([{ position: 1, attachmentId: a1.id }]);

    const reloaded: Message = {
      role: "user",
      content: [
        { type: "text", text: "two images, first one skipped" },
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
    rehydrateAttachmentIds(reloaded, links);

    // The id must land on the SECOND media block (its real upload), and the
    // first must stay untagged. A compacted id-only list would have wrongly put
    // a1.id on the first block, so its media_ref would point at the wrong image.
    expect((reloaded.content[1] as ImageContent)._attachmentId).toBeUndefined();
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
