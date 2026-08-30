import { describe, expect, test } from "bun:test";

import {
  countMediaBlocks,
  stripMediaPayloadsForRetry,
} from "../daemon/conversation-media-retry.js";
import {
  KEEP_LATEST_SIGHT_FRAMES,
  stripAgedSightFrames,
} from "../daemon/conversation-sight-frames.js";
import { sightFrameAttachmentIdsFromMetadata } from "../persistence/conversation-types.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An attachment reference block, the shape persisted history carries. */
function referenceImage(
  attachmentId: string,
  sizeBytes = 1024,
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: {
      type: "workspace_ref",
      media_type: "image/jpeg",
      attachmentId,
      sizeBytes,
    },
  };
}

/** An inline upload, which carries no attachment id to match against. */
function inlineImage(): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  };
}

function user(...blocks: ContentBlock[]): Message {
  return { role: "user", content: blocks };
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** Capture times for tagged frames, one second apart from a fixed instant. */
function captureTimes(...attachmentIds: string[]): Map<string, number> {
  const base = Date.parse("2026-08-30T14:25:00.000Z");
  return new Map(attachmentIds.map((id, i) => [id, base + i * 1000]));
}

function textOf(message: Message, index: number): string {
  const block = message.content[index];
  return block.type === "text" ? block.text : "";
}

// ---------------------------------------------------------------------------
// stripAgedSightFrames
// ---------------------------------------------------------------------------

describe("stripAgedSightFrames", () => {
  test("keeps the newest frames and stubs the rest", () => {
    const messages: Message[] = [
      user({ type: "text", text: "one" }, referenceImage("f1")),
      assistant("ok"),
      user({ type: "text", text: "two" }, referenceImage("f2")),
      assistant("ok"),
      user({ type: "text", text: "three" }, referenceImage("f3")),
      assistant("ok"),
      user({ type: "text", text: "four" }, referenceImage("f4")),
      user({ type: "text", text: "five" }, referenceImage("f5")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4", "f5"),
    );

    expect(result.modified).toBe(true);
    expect(result.replacedBlocks).toBe(3);

    const surviving = result.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "image"),
    );
    expect(surviving).toHaveLength(KEEP_LATEST_SIGHT_FRAMES);
    expect(surviving).toEqual([referenceImage("f4"), referenceImage("f5")]);

    expect(textOf(result.messages[0], 1)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:00.000Z, image/jpeg, 1024 bytes]",
    );
    expect(textOf(result.messages[2], 1)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:01.000Z, image/jpeg, 1024 bytes]",
    );
    expect(textOf(result.messages[4], 1)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:02.000Z, image/jpeg, 1024 bytes]",
    );
  });

  test("stubs several frames on one message independently", () => {
    const messages: Message[] = [
      user(referenceImage("f1"), referenceImage("f2"), referenceImage("f3")),
      user(referenceImage("f4")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4"),
    );

    expect(result.replacedBlocks).toBe(2);
    expect(result.messages[0].content.map((b) => b.type)).toEqual([
      "text",
      "text",
      "image",
    ]);
    expect(result.messages[1].content.map((b) => b.type)).toEqual(["image"]);
  });

  test("leaves untagged media alone, even interleaved with frames", () => {
    const pickedReference = referenceImage("picked-1", 4096);
    const pickedInline = inlineImage();
    const pickedFile: ContentBlock = {
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: "application/pdf",
        attachmentId: "picked-2",
        sizeBytes: 2048,
        filename: "notes.pdf",
      },
    };
    const messages: Message[] = [
      user(referenceImage("f1"), pickedReference),
      user(pickedInline, referenceImage("f2"), pickedFile),
      user(referenceImage("f3"), referenceImage("f4")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4"),
    );

    expect(result.replacedBlocks).toBe(2);
    expect(result.messages[0].content[1]).toBe(pickedReference);
    expect(result.messages[1].content[0]).toBe(pickedInline);
    expect(result.messages[1].content[2]).toBe(pickedFile);
    expect(result.messages[2]).toBe(messages[2]);
  });

  test("ignores tagged ids that match no attachment on the row", () => {
    const messages: Message[] = [
      user(referenceImage("f1")),
      user(referenceImage("f2")),
      user(referenceImage("f3")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("gone-1", "gone-2", "gone-3"),
    );

    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("is inert when nothing is tagged", () => {
    const messages: Message[] = [
      user({ type: "text", text: "look" }, referenceImage("a1")),
      assistant("ok"),
      user(inlineImage(), referenceImage("a2"), referenceImage("a3")),
      assistant("ok"),
      user(referenceImage("a4"), { type: "text", text: "and this" }),
    ];
    const before = structuredClone(messages);

    const result = stripAgedSightFrames(messages, new Map());

    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);
    expect(result.messages).toBe(messages);
    expect(result.messages).toEqual(before);
  });

  test("leaves a conversation at or under the budget untouched", () => {
    const messages: Message[] = [
      user(referenceImage("f1")),
      user(referenceImage("f2")),
    ];

    const result = stripAgedSightFrames(messages, captureTimes("f1", "f2"));

    expect(result.modified).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// Composition with the reactive retry path
// ---------------------------------------------------------------------------

describe("stripAgedSightFrames composed with stripMediaPayloadsForRetry", () => {
  test("proactive stubs are invisible to the retry path", () => {
    const messages: Message[] = [
      user(referenceImage("f1"), referenceImage("picked-1", 4096)),
      assistant("ok"),
      user(referenceImage("f2")),
      assistant("ok"),
      user(
        { type: "text", text: "latest" },
        referenceImage("f3"),
        referenceImage("f4"),
        referenceImage("picked-2", 4096),
        referenceImage("picked-3", 4096),
      ),
    ];
    expect(countMediaBlocks(messages)).toBe(7);

    const trimmed = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4"),
    ).messages;
    // The two stubbed frames are text now, so the retry path cannot see them.
    expect(countMediaBlocks(trimmed)).toBe(5);

    const retried = stripMediaPayloadsForRetry(trimmed);

    // Only the real media the retry path owns is replaced: the older message's
    // picked image, plus the fourth media block of the latest user message.
    expect(retried.replacedBlocks).toBe(2);
    expect(countMediaBlocks(retried.messages)).toBe(3);

    const stubTexts = retried.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "text").map((b) => b.text),
    );
    const cameraStubs = stubTexts.filter((t) =>
      t.startsWith("[Camera frame omitted from context:"),
    );
    expect(cameraStubs).toHaveLength(2);
    expect(
      stubTexts.filter((t) =>
        t.startsWith("[Image omitted from retry context:"),
      ),
    ).toHaveLength(2);
    // Nothing wrapped a camera stub in a retry stub.
    for (const stub of cameraStubs) {
      expect(stub.includes("retry context")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata reader
// ---------------------------------------------------------------------------

describe("sightFrameAttachmentIdsFromMetadata", () => {
  test("reads the tagged ids", () => {
    expect(
      sightFrameAttachmentIdsFromMetadata({
        voiceSessionTurn: true,
        sightFrameAttachmentIds: ["att-1", "att-2"],
      }),
    ).toEqual(["att-1", "att-2"]);
  });

  test("yields nothing for absent, null, or malformed values", () => {
    expect(sightFrameAttachmentIdsFromMetadata(undefined)).toEqual([]);
    expect(sightFrameAttachmentIdsFromMetadata(null)).toEqual([]);
    expect(sightFrameAttachmentIdsFromMetadata({})).toEqual([]);
    expect(
      sightFrameAttachmentIdsFromMetadata({ sightFrameAttachmentIds: "att-1" }),
    ).toEqual([]);
    expect(
      sightFrameAttachmentIdsFromMetadata({
        sightFrameAttachmentIds: ["att-1", "", 7, null],
      }),
    ).toEqual(["att-1"]);
  });
});
