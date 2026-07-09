import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { referenceMediaBlocksForPersist } from "../daemon/persist-media-references.js";
import { getAttachmentsForMessage } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { mediaSourceBytes } from "../providers/media-resolve.js";
import type { ContentBlock } from "../providers/types.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

// "aGVsbG8=" = "hello"
const IMAGE_B64 = Buffer.from("hello").toString("base64");

describe("referenceMediaBlocksForPersist", () => {
  beforeEach(resetTables);

  test("materializes tool_result base64 media into a linked workspace_ref", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");

    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "screenshot captured",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: IMAGE_B64,
            },
          },
        ],
      },
    ];

    const referenced = referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      blocks,
    );

    // The nested image is now a workspace_ref, not inline base64.
    const toolResult = referenced[0] as Extract<
      ContentBlock,
      { type: "tool_result" }
    >;
    const nested = toolResult.contentBlocks![0] as Extract<
      ContentBlock,
      { type: "image" }
    >;
    expect(nested.source.type).toBe("workspace_ref");
    expect(JSON.stringify(referenced)).not.toContain(IMAGE_B64);

    // The attachment row is linked to the message (GC anchor) and its bytes
    // resolve back to the original image.
    if (nested.source.type !== "workspace_ref") throw new Error("expected ref");
    const linked = getAttachmentsForMessage(msg.id);
    expect(linked.map((a) => a.id)).toEqual([nested.source.attachmentId]);
    expect(mediaSourceBytes(nested.source)?.toString()).toBe("hello");
  });

  test("leaves an already-referenced block untouched and creates no row", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");

    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "ok",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "workspace_ref",
              media_type: "image/png",
              attachmentId: "att-existing",
              sizeBytes: 5,
            },
          },
        ],
      },
    ];

    const referenced = referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      blocks,
    );

    expect(referenced).toEqual(blocks);
    expect(getAttachmentsForMessage(msg.id)).toHaveLength(0);
  });
});
