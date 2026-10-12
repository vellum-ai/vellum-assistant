import { beforeEach, describe, expect, test } from "bun:test";

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

    const referenced = await referenceMediaBlocksForPersist(
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
    if (nested.source.type !== "workspace_ref") {
      throw new Error("expected ref");
    }
    const linked = getAttachmentsForMessage(msg.id);
    expect(linked.map((a) => a.id)).toEqual([nested.source.attachmentId]);
    expect(mediaSourceBytes(nested.source)?.toString()).toBe("hello");
    // The reference hints what the send path puts on the wire. These bytes
    // are not an image any provider reads, so the resolver would substitute a
    // text note and the hint says nothing goes out.
    expect(nested.source.transportSizeBytes).toBe(0);
  });

  test("normalizes a tool image's declared type to its sniffed format", async () => {
    // A tool's declared media type is only a claim. The store sniffs the
    // bytes the way uploads are sniffed, so the reference describes the
    // stored format and the outbound sanitizer's readability check (which
    // trusts the reference's type) agrees with what the resolver will send.
    const conv = createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");
    const pngBytesDeclaredSvg =
      "iVBORw0KGgoAAAANSUhEUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    const referenced = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      [
        {
          type: "tool_result",
          tool_use_id: "tool-mislabeled",
          content: "rendered",
          contentBlocks: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/svg+xml",
                data: pngBytesDeclaredSvg,
              },
            },
          ],
        },
      ],
    );

    const toolResult = referenced[0] as Extract<
      ContentBlock,
      { type: "tool_result" }
    >;
    const nested = toolResult.contentBlocks![0] as Extract<
      ContentBlock,
      { type: "image" }
    >;
    if (nested.source.type !== "workspace_ref") {
      throw new Error("expected ref");
    }
    expect(nested.source.media_type).toBe("image/png");
    expect(nested.source.transportSizeBytes).toBe(
      Buffer.byteLength(pngBytesDeclaredSvg, "base64"),
    );
  });

  test("records a zero transport size for stored bytes no provider reads", async () => {
    // Normalization can only correct a declared type the sniffer recognizes;
    // SVG bytes declared as PNG keep the PNG label. The hint is derived from
    // the stored bytes, so it still says nothing goes on the wire, and the
    // outbound sanitizer's payload cap costs the reference as nothing.
    const conv = createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");
    const svgDeclaredPng = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    ).toString("base64");

    const referenced = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      [
        {
          type: "tool_result",
          tool_use_id: "tool-svg",
          content: "rendered",
          contentBlocks: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: svgDeclaredPng,
              },
            },
          ],
        },
      ],
    );

    const toolResult = referenced[0] as Extract<
      ContentBlock,
      { type: "tool_result" }
    >;
    const nested = toolResult.contentBlocks![0] as Extract<
      ContentBlock,
      { type: "image" }
    >;
    if (nested.source.type !== "workspace_ref") {
      throw new Error("expected ref");
    }
    expect(nested.source.media_type).toBe("image/png");
    expect(nested.source.transportSizeBytes).toBe(0);
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

    const referenced = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      blocks,
    );

    expect(referenced).toEqual(blocks);
    expect(getAttachmentsForMessage(msg.id)).toHaveLength(0);
  });

  test("retries unresolved materialization and applies the computer-use filename", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");
    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "computer-use-call",
        content: "clicked",
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
    const toolNames = new Map([["computer-use-call", "computer_use_click"]]);

    const unresolved = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      "missing-message",
      blocks,
      toolNames,
    );
    expect(unresolved).toEqual(blocks);

    const recovered = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      unresolved,
      toolNames,
    );
    const nested = (
      recovered[0] as Extract<ContentBlock, { type: "tool_result" }>
    ).contentBlocks?.[0];
    if (!nested || nested.type !== "image") {
      throw new Error("expected recovered image");
    }
    expect(nested.source.type).toBe("workspace_ref");
    expect(getAttachmentsForMessage(msg.id)).toEqual([
      expect.objectContaining({ originalFilename: "computer-use-click.png" }),
    ]);
  });
});
