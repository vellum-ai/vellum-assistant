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

/**
 * The live in-memory copy of an upload: inline bytes plus the attachment id
 * that ties it to the row persisted as a reference. `data` is 8 base64 chars,
 * so `mediaSourceByteLength` reports 6 bytes.
 */
function liveImage(
  attachmentId: string,
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "AAAAAAAA" },
    _attachmentId: attachmentId,
  };
}

/**
 * A block in the shape `buildRetainedImageBlocks` rebuilds: inline bytes
 * re-hydrated from the attachment store, stamped with the manifest entry's id.
 */
function retainedImage(
  attachmentId: string,
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAAAAAA" },
    _attachmentId: attachmentId,
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
      user(inlineImage(), referenceImage("a2"), liveImage("a3")),
      assistant("ok"),
      user(liveImage("a4"), { type: "text", text: "and this" }),
    ];
    const before = structuredClone(messages);

    const result = stripAgedSightFrames(messages, new Map());

    expect(result.modified).toBe(false);
    expect(result.replacedBlocks).toBe(0);
    expect(result.messages).toBe(messages);
    expect(result.messages).toEqual(before);
  });

  test("stubs live inline frames on a call that never reloaded", () => {
    // Every frame is the in-memory copy a turn pushed, so nothing in this
    // history is a `workspace_ref`. This is the uninterrupted-call case.
    const messages: Message[] = [
      user({ type: "text", text: "one" }, liveImage("f1")),
      assistant("ok"),
      user({ type: "text", text: "two" }, liveImage("f2")),
      assistant("ok"),
      user({ type: "text", text: "three" }, liveImage("f3")),
      assistant("ok"),
      user({ type: "text", text: "four" }, liveImage("f4")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4"),
    );

    expect(result.modified).toBe(true);
    expect(result.replacedBlocks).toBe(2);
    expect(textOf(result.messages[0], 1)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:00.000Z, image/jpeg, 6 bytes]",
    );
    expect(textOf(result.messages[2], 1)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:01.000Z, image/jpeg, 6 bytes]",
    );
    expect(result.messages[4].content[1]).toEqual(liveImage("f3"));
    expect(result.messages[6].content[1]).toEqual(liveImage("f4"));
  });

  test("ranks live and reloaded frames in one pool", () => {
    // A conversation reloaded mid-call: the older turns came back from the DB
    // as references, the newer ones are still the live copies. The newest two
    // survive regardless of which shape they are.
    const messages: Message[] = [
      user(referenceImage("f1")),
      user(referenceImage("f2")),
      user(liveImage("f3")),
      user(referenceImage("f4")),
      user(liveImage("f5")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4", "f5"),
    );

    expect(result.replacedBlocks).toBe(3);
    expect(result.messages[0].content[0].type).toBe("text");
    expect(result.messages[1].content[0].type).toBe("text");
    expect(result.messages[2].content[0].type).toBe("text");
    expect(result.messages[3].content[0]).toEqual(referenceImage("f4"));
    expect(result.messages[4].content[0]).toEqual(liveImage("f5"));
  });

  test("ignores an inline image whose id was never tagged", () => {
    const messages: Message[] = [
      user(liveImage("picked-1")),
      user(liveImage("f1")),
      user(liveImage("f2")),
      user(liveImage("f3")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3"),
    );

    expect(result.replacedBlocks).toBe(1);
    expect(result.messages[0].content[0]).toEqual(liveImage("picked-1"));
    expect(result.messages[1].content[0].type).toBe("text");
  });

  test("re-stubs frames that compaction pulled back into the history", () => {
    // Compaction builds its image manifest from the stored rows, not from the
    // trimmed copy a turn sent, so a frame this pass already stubbed can come
    // back as a rebuilt inline block. The history below is the shape compaction
    // leaves behind (summary, retained-images message, verbatim tail), written
    // out rather than produced by a real compaction run, which would need a
    // provider call. The bound has to re-apply over it.
    const messages: Message[] = [
      assistant("<context_summary>earlier call</context_summary>"),
      user(
        {
          type: "text",
          text: "Images retained from the compacted portion of the conversation:",
        },
        retainedImage("f1"),
        retainedImage("f2"),
        retainedImage("f3"),
      ),
      user({ type: "text", text: "and now" }, liveImage("f4")),
    ];

    const result = stripAgedSightFrames(
      messages,
      captureTimes("f1", "f2", "f3", "f4"),
    );

    expect(result.replacedBlocks).toBe(2);
    expect(textOf(result.messages[1], 1)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:00.000Z, image/png, 6 bytes]",
    );
    expect(textOf(result.messages[1], 2)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:01.000Z, image/png, 6 bytes]",
    );
    // The newest retained frame and the tail's live frame are the survivors.
    expect(result.messages[1].content[3]).toEqual(retainedImage("f3"));
    expect(result.messages[2].content[1]).toEqual(liveImage("f4"));
  });

  test("ranks compaction-rebuilt frames by capture time, not position", () => {
    // Compaction lists the frames it keeps in the MODEL's order inside one
    // synthetic message, so their position stops tracking recency. Here the
    // newest frame (f4) sits first and the oldest (f1) last. Ranking by
    // position would stub f4 and keep f1; ranking by capture time keeps f4.
    const times = captureTimes("f1", "f2", "f3", "f4");
    const messages: Message[] = [
      assistant("<context_summary>earlier call</context_summary>"),
      user(
        {
          type: "text",
          text: "Images retained from the compacted portion of the conversation:",
        },
        retainedImage("f4"),
        retainedImage("f3"),
        retainedImage("f2"),
        retainedImage("f1"),
      ),
    ];

    const result = stripAgedSightFrames(messages, times);

    expect(result.replacedBlocks).toBe(2);
    const retained = result.messages[1];
    // The two newest survive wherever they sit.
    expect(retained.content[1]).toEqual(retainedImage("f4"));
    expect(retained.content[2]).toEqual(retainedImage("f3"));
    // The two oldest are stubbed, each naming its own capture time.
    expect(textOf(retained, 3)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:01.000Z, image/png, 6 bytes]",
    );
    expect(textOf(retained, 4)).toBe(
      "[Camera frame omitted from context: captured 2026-08-30T14:25:00.000Z, image/png, 6 bytes]",
    );
  });

  test("falls back to history order for frames sharing a capture time", () => {
    // Frames attached to the same row share its `createdAt`, so the tiebreak
    // is the order they sit in the history, which is the order they arrived.
    const sameRow = new Map([
      ["f1", 1000],
      ["f2", 1000],
      ["f3", 1000],
    ]);
    const messages: Message[] = [
      user(retainedImage("f1"), retainedImage("f2"), retainedImage("f3")),
    ];

    const result = stripAgedSightFrames(messages, sameRow);

    expect(result.replacedBlocks).toBe(1);
    expect(result.messages[0].content[0].type).toBe("text");
    expect(result.messages[0].content[1]).toEqual(retainedImage("f2"));
    expect(result.messages[0].content[2]).toEqual(retainedImage("f3"));
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
