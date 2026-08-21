import { beforeEach, describe, expect, test } from "bun:test";

import {
  unsendableImageCardText,
  unsendableImageFilenames,
} from "../daemon/unsendable-image-notice.js";
import { createInlineAttachment } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  isUnsendableImageSource,
  resolveMediaReferences,
  UNSENDABLE_IMAGE_FORMAT_NOTE,
} from "../providers/media-resolve.js";
import type { ContentBlock, Message } from "../providers/types.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** A 1x1 PNG: a real signature plus enough body to be a decodable image. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/**
 * A HEIC head (ISO BMFF `ftyp` + the `heic` brand) under a `.png` name, which
 * is what a photo renamed by hand or exported by iOS arrives as.
 */
const HEIC_B64 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00,
  0x00, 0x00, 0x00,
]).toString("base64");

/** A PNG whose signature bytes are damaged, as a partial upload leaves it. */
const CORRUPT_PNG_B64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]).toString("base64");

function userMessage(content: ContentBlock[]): Message {
  return { role: "user", content };
}

function inlineImage(mediaType: string, data: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

async function storedImageRef(
  filename: string,
  mimeType: string,
  dataBase64: string,
): Promise<ContentBlock> {
  const conv = createConversation();
  const stored = await createInlineAttachment(
    conv.id,
    conv.createdAt,
    filename,
    mimeType,
    dataBase64,
  );
  return {
    type: "image",
    source: {
      type: "workspace_ref",
      media_type: mimeType,
      attachmentId: stored.id,
      sizeBytes: stored.sizeBytes,
      filename,
    },
  };
}

describe("resolveMediaReferences image validation", () => {
  beforeEach(resetTables);

  test("sends a valid inline image untouched", async () => {
    // GIVEN a message carrying an inline PNG whose bytes match its declaration
    const message = userMessage([inlineImage("image/png", PNG_B64)]);

    // WHEN the send boundary resolves it
    const [resolved] = await resolveMediaReferences([message]);

    // THEN the block is unchanged, and the message is the same object (no
    // allocation or disk read on the clean live-turn fast path)
    expect(resolved).toBe(message);
  });

  test("drops the unreadable image from a batch and keeps the valid ones", async () => {
    // GIVEN a batch of a valid PNG, a HEIC photo declared as a PNG, and a
    // truncated PNG: the shape of the eight-image upload that lost a whole turn
    const message = userMessage([
      { type: "text", text: "what is in these?" },
      inlineImage("image/png", PNG_B64),
      inlineImage("image/png", HEIC_B64),
      inlineImage("image/png", CORRUPT_PNG_B64),
    ]);

    // WHEN the send boundary resolves them
    const [resolved] = await resolveMediaReferences([message]);

    // THEN the valid image still goes to the model
    expect(resolved.content[1]).toEqual(inlineImage("image/png", PNG_B64));

    // AND each unreadable image is replaced by a note instead of failing the
    // whole request
    expect(resolved.content[2]).toEqual({
      type: "text",
      text: UNSENDABLE_IMAGE_FORMAT_NOTE,
    });
    expect(resolved.content[3]).toEqual({
      type: "text",
      text: UNSENDABLE_IMAGE_FORMAT_NOTE,
    });
  });

  test("keeps a HEIC photo for a provider that decodes HEIF", async () => {
    /**
     * Gemini reads image/heic and image/heif directly, so an untranscoded HEIC
     * photo must reach it as an image rather than as an omission note.
     */
    // GIVEN a HEIC photo declared as a PNG, as an untranscoded upload arrives
    const message = userMessage([inlineImage("image/png", HEIC_B64)]);

    // WHEN a provider that accepts HEIF resolves it
    const [resolved] = await resolveMediaReferences([message], {
      acceptsHeif: true,
    });

    // THEN the image survives, declared as the HEIF type its brand names
    expect(resolved.content[0]).toEqual(inlineImage("image/heic", HEIC_B64));
  });

  test("relabels an inline image whose declared type is not its actual type", async () => {
    // GIVEN PNG bytes declared as JPEG, which every provider rejects outright
    const message = userMessage([inlineImage("image/jpeg", PNG_B64)]);

    // WHEN the send boundary resolves it
    const [resolved] = await resolveMediaReferences([message]);

    // THEN the declaration is corrected to what the bytes are, payload intact
    expect(resolved.content[0]).toEqual(inlineImage("image/png", PNG_B64));
  });

  test("drops a stored image whose bytes are not a readable format", async () => {
    // GIVEN a persisted attachment holding HEIC bytes under a .png name,
    // referenced by a reloaded message
    const block = await storedImageRef("photo.png", "image/png", HEIC_B64);

    // WHEN the send boundary resolves the reference
    const [resolved] = await resolveMediaReferences([userMessage([block])]);

    // THEN it is replaced by the note rather than hydrated and sent
    expect(resolved.content[0]).toEqual({
      type: "text",
      text: UNSENDABLE_IMAGE_FORMAT_NOTE,
    });
  });

  test("keeps the unavailable-attachment note for a reference with no bytes", async () => {
    // GIVEN a reference to an attachment row that does not exist
    const block: ContentBlock = {
      type: "image",
      source: {
        type: "workspace_ref",
        media_type: "image/png",
        attachmentId: "missing-attachment",
        sizeBytes: 1024,
        filename: "gone.png",
      },
    };

    // WHEN the send boundary resolves it
    const [resolved] = await resolveMediaReferences([userMessage([block])]);

    // THEN an unreadable payload is reported as unavailable, not as a bad
    // format: the file may simply have been collected
    expect(resolved.content[0]).toEqual({
      type: "text",
      text: "[Attachment unavailable: image could not be loaded]",
    });
  });

  test("validates images nested in a tool result", async () => {
    // GIVEN a tool result carrying one readable and one corrupt image
    const message = userMessage([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "two screenshots",
        contentBlocks: [
          inlineImage("image/png", PNG_B64),
          inlineImage("image/png", CORRUPT_PNG_B64),
        ],
      },
    ]);

    // WHEN the send boundary resolves it
    const [resolved] = await resolveMediaReferences([message]);

    // THEN the tool_use/tool_result pairing survives with the bad image noted
    const toolResult = resolved.content[0];
    if (toolResult.type !== "tool_result") {
      throw new Error(`expected tool_result, got ${toolResult.type}`);
    }
    expect(toolResult.contentBlocks).toEqual([
      inlineImage("image/png", PNG_B64),
      { type: "text", text: UNSENDABLE_IMAGE_FORMAT_NOTE },
    ]);
  });
});

describe("isUnsendableImageSource", () => {
  beforeEach(resetTables);

  test("reports a stored attachment the send boundary will drop", async () => {
    // GIVEN one attachment holding a real PNG and one holding HEIC bytes
    const good = await storedImageRef("good.png", "image/png", PNG_B64);
    const bad = await storedImageRef("bad.png", "image/png", HEIC_B64);
    if (good.type !== "image" || bad.type !== "image") {
      throw new Error("expected image blocks");
    }

    // WHEN each source is checked
    // THEN only the unreadable one is reported, matching what the boundary does
    expect(isUnsendableImageSource(good.source)).toBe(false);
    expect(isUnsendableImageSource(bad.source)).toBe(true);
  });

  test("does not report a reference whose attachment is gone", () => {
    // GIVEN a reference with no row behind it
    // WHEN it is checked
    // THEN it is not called unsendable: a missing payload is a separate
    // failure, and naming it in the drop card would misinform the user
    expect(
      isUnsendableImageSource({
        type: "workspace_ref",
        media_type: "image/png",
        attachmentId: "missing-attachment",
        sizeBytes: 10,
        filename: "gone.png",
      }),
    ).toBe(false);
  });
});

describe("unsendable-image notice", () => {
  beforeEach(resetTables);

  test("names only the attachments the model cannot see", async () => {
    // GIVEN a message whose attachments are one valid PNG and one HEIC-as-PNG
    const msgConv = createConversation();
    await addMessage(msgConv.id, "user", "look at these");
    const good = await storedImageRef("holiday.png", "image/png", PNG_B64);
    const bad = await storedImageRef("beach.png", "image/png", HEIC_B64);
    if (good.type !== "image" || bad.type !== "image") {
      throw new Error("expected image blocks");
    }

    // WHEN the notice decides what to name
    const filenames = unsendableImageFilenames([
      { filename: "holiday.png", source: good.source },
      { filename: "beach.png", source: bad.source },
    ]);

    // THEN only the dropped file is named, so the user knows which to convert
    expect(filenames).toEqual(["beach.png"]);

    // AND the card copy names it and says what to do about it
    expect(unsendableImageCardText(filenames)).toBe(
      "beach.png was not sent to the model: the file is not a PNG, JPEG, GIF, or WebP image. Convert it and attach it again to include it.",
    );
  });

  test("posts no notice when every attachment is readable", async () => {
    // GIVEN attachments that are all valid images
    const good = await storedImageRef("one.png", "image/png", PNG_B64);
    if (good.type !== "image") {
      throw new Error("expected an image block");
    }

    // WHEN the notice decides what to name
    // THEN there is nothing to say, so no card is written
    expect(
      unsendableImageFilenames([{ filename: "one.png", source: good.source }]),
    ).toEqual([]);
  });

  test("names every dropped file when a batch has several", () => {
    // GIVEN two inline attachments whose bytes are unreadable
    // WHEN the card copy is built for them
    const text = unsendableImageCardText(["a.png", "b.png"]);

    // THEN both are named in plural copy
    expect(text).toBe(
      "a.png, b.png were not sent to the model: the files are not PNG, JPEG, GIF, or WebP images. Convert them and attach them again to include them.",
    );
  });
});
