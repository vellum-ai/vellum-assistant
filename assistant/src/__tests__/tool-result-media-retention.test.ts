import { describe, expect, test } from "bun:test";

import {
  preModelCallSanitize,
  retainedToolResultMediaKeys,
  retainedToolResultMediaKeysBeforeCap,
} from "../context/outbound-sanitize.js";
import type {
  ContentBlock,
  MediaRetention,
  Message,
  ToolResultContent,
} from "../providers/types.js";

const MB = 1024 * 1024;

/** An inline image whose base64 payload is exactly `wireBytes` long. */
function inlineImage(wireBytes: number): ContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "A".repeat(wireBytes),
    },
  };
}

/** An inline MP3 of `decodedBytes`, which every adapter inlines and the transport cap does not shrink. */
function inlineAudio(decodedBytes: number): ContentBlock {
  return {
    type: "file",
    source: {
      type: "base64",
      media_type: "audio/mpeg",
      data: "A".repeat(Math.ceil((decodedBytes * 4) / 3)),
    },
  };
}

/** A persisted image reference of `sizeBytes` decoded bytes. */
function refImage(sizeBytes: number): ContentBlock {
  return {
    type: "image",
    source: {
      type: "workspace_ref",
      media_type: "image/png",
      attachmentId: "att-1",
      sizeBytes,
    },
  };
}

/** A persisted file reference of `sizeBytes` decoded bytes and the given MIME type. */
function refFile(mediaType: string, sizeBytes: number): ContentBlock {
  return {
    type: "file",
    source: {
      type: "workspace_ref",
      media_type: mediaType,
      attachmentId: "att-file",
      sizeBytes,
      filename: "attachment",
    },
  };
}

/** One tool step: the assistant's call and the user-role result carrying media. */
function toolStep(
  id: string,
  retention: MediaRetention | undefined,
  media: ContentBlock[],
): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "read", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: `loaded ${id}`,
          contentBlocks: media,
          ...(retention ? { mediaRetention: retention } : {}),
        },
      ],
    },
  ];
}

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

/** `n` sequential document steps of `wireBytes` each, ids `d1..dn`. */
function documentSteps(n: number, wireBytes: number): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(...toolStep(`d${i}`, "document", [inlineImage(wireBytes)]));
  }
  return out;
}

function toolResult(history: Message[], msgIdx: number): ToolResultContent {
  const block = history[msgIdx].content[0];
  if (block.type !== "tool_result") {
    throw new Error(`message ${msgIdx} is not a tool result`);
  }
  return block;
}

const hasMedia = (block: ToolResultContent): boolean =>
  block.contentBlocks?.some((b) => b.type === "image" || b.type === "file") ??
  false;

describe("tool-result media retention", () => {
  test("frame media (the default) survives only in the current tool step", () => {
    // GIVEN two sequential screenshot steps with no retention declared
    const history = [
      userText("go"),
      ...toolStep("s1", undefined, [inlineImage(100)]),
      ...toolStep("s2", undefined, [inlineImage(100)]),
    ];

    // WHEN the outbound copy is sanitized
    const sent = preModelCallSanitize(history);

    // THEN the older frame is replaced by the removed-media marker and the
    // newest frame is kept
    const older = toolResult(sent, 2);
    expect(hasMedia(older)).toBe(false);
    expect(older.content).toStartWith("loaded s1");
    expect(older.content).toContain("binary data removed to save context");
    expect(hasMedia(toolResult(sent, 4))).toBe(true);
    // AND the durable history is untouched
    expect(hasMedia(toolResult(history, 2))).toBe(true);
  });

  test("anything but an explicit document class is treated as a frame", () => {
    // GIVEN an older result whose class is not one the policy knows
    const history = [
      ...toolStep("x1", "forever" as unknown as MediaRetention, [
        inlineImage(100),
      ]),
      ...toolStep("s2", undefined, [inlineImage(100)]),
    ];

    // THEN it follows the frame rule and is dropped behind the current step
    expect(hasMedia(toolResult(preModelCallSanitize(history), 1))).toBe(false);
  });

  test("document media is kept across steps and across user turns", () => {
    // GIVEN file reads on two steps of one turn, a new user turn, then another read
    const history = [
      userText("compare the renders"),
      ...toolStep("d1", "document", [inlineImage(100)]),
      ...toolStep("d2", "document", [inlineImage(100)]),
      userText("and the newest one?"),
      ...toolStep("d3", "document", [inlineImage(100)]),
    ];

    // WHEN sanitized
    const sent = preModelCallSanitize(history);

    // THEN every read is still in view
    expect(sent).toEqual(history);
    expect(retainedToolResultMediaKeys(history)).toEqual(
      new Set(["2:0", "4:0", "7:0"]),
    );
  });

  test("frames and documents follow their own rules in one history", () => {
    // GIVEN an old screenshot, an old file read, then a fresh screenshot
    const history = [
      userText("go"),
      ...toolStep("s1", "frame", [inlineImage(100)]),
      ...toolStep("d1", "document", [inlineImage(100)]),
      ...toolStep("s2", "frame", [inlineImage(100)]),
    ];

    // WHEN sanitized
    const sent = preModelCallSanitize(history);

    // THEN the old screenshot is dropped, the file read and the fresh
    // screenshot are kept
    expect(hasMedia(toolResult(sent, 2))).toBe(false);
    expect(hasMedia(toolResult(sent, 4))).toBe(true);
    expect(hasMedia(toolResult(sent, 6))).toBe(true);
  });

  test("the byte cap evicts the oldest documents down to the low mark, once per crossing", () => {
    // GIVEN the 10 MB high / 6 MB low band and 2.5 MB reads

    // WHEN four reads total 10 MB, on the mark
    const four = documentSteps(4, 2.5 * MB);
    // THEN nothing is evicted
    expect(preModelCallSanitize(four)).toEqual(four);

    // WHEN a fifth read pushes the total to 12.5 MB
    const five = documentSteps(5, 2.5 * MB);
    const sentFive = preModelCallSanitize(five);
    // THEN the three oldest are evicted (12.5 -> 10 -> 7.5 -> 5 MB, under
    // the low mark)
    expect(retainedToolResultMediaKeys(five)).toEqual(new Set(["7:0", "9:0"]));
    const evicted = toolResult(sentFive, 1);
    expect(hasMedia(evicted)).toBe(false);
    expect(evicted.content).toStartWith("loaded d1");
    expect(evicted.content).toContain("payload limit");
    expect(evicted.content).toContain("Call the tool again");

    // WHEN a sixth and seventh read arrive (7.5 MB, then 10 MB on the mark)
    const seven = documentSteps(7, 2.5 * MB);
    const sentSeven = preModelCallSanitize(seven);
    // THEN no new eviction happens and the earlier prefix is byte-identical,
    // so the prompt cache holds between crossings
    expect(retainedToolResultMediaKeys(seven)).toEqual(
      new Set(["7:0", "9:0", "11:0", "13:0"]),
    );
    expect(JSON.stringify(sentSeven.slice(0, five.length))).toBe(
      JSON.stringify(sentFive),
    );

    // WHEN an eighth read crosses the high mark again (12.5 MB)
    const eight = documentSteps(8, 2.5 * MB);
    // THEN the next three oldest go
    expect(retainedToolResultMediaKeys(eight)).toEqual(
      new Set(["13:0", "15:0"]),
    );
  });

  test("a crossing never evicts the step that caused it", () => {
    // GIVEN a single audio read above the high mark on its own (9 MB raw is
    // 12 MB on the wire)
    const alone = toolStep("d1", "document", [inlineAudio(9 * MB)]);
    // THEN it is still sent
    expect(preModelCallSanitize(alone)).toEqual(alone);

    // GIVEN a small image read followed by that audio read
    const history = [
      ...toolStep("d1", "document", [inlineImage(1 * MB)]),
      ...toolStep("d2", "document", [inlineAudio(9 * MB)]),
    ];
    // THEN only the older read is evicted
    expect(retainedToolResultMediaKeys(history)).toEqual(new Set(["3:0"]));
  });

  test("the image-count cap evicts oldest documents down to the low count", () => {
    // GIVEN 81 tiny reads against an 80-image high mark and 50-image low mark
    const history = documentSteps(81, 1);

    // WHEN sanitized
    const retained = retainedToolResultMediaKeys(history);

    // THEN the newest 50 are kept and the oldest 31 are evicted
    expect(retained.size).toBe(50);
    expect(retained.has(`${2 * 31 - 1}:0`)).toBe(false);
    expect(retained.has(`${2 * 32 - 1}:0`)).toBe(true);
    expect(retained.has(`${2 * 81 - 1}:0`)).toBe(true);
  });

  test("user attachments count toward the cap but are never evicted", () => {
    // GIVEN a 6 MB user upload followed by two 3 MB reads
    const upload: Message = {
      role: "user",
      content: [{ type: "text", text: "here" }, inlineImage(6 * MB)],
    };
    const history = [
      upload,
      ...toolStep("d1", "document", [inlineImage(3 * MB)]),
      ...toolStep("d2", "document", [inlineImage(3 * MB)]),
    ];

    // WHEN sanitized (9 MB fits under the 10 MB mark, 12 MB does not)
    const sent = preModelCallSanitize(history);

    // THEN the upload is intact, the older read is evicted, the newer read kept
    expect(sent[0]).toEqual(upload);
    expect(hasMedia(toolResult(sent, 2))).toBe(false);
    expect(hasMedia(toolResult(sent, 4))).toBe(true);
  });

  test("a persisted reference is costed at its base64 size on the wire", () => {
    // GIVEN a 7.5 MB audio reference (10 MB as base64, exactly the high
    // mark) and a 4-byte inline read after it
    const history = [
      ...toolStep("d1", "document", [refFile("audio/mpeg", 7.5 * MB)]),
      ...toolStep("d2", "document", [inlineImage(4)]),
    ];

    // WHEN sanitized
    const retained = retainedToolResultMediaKeys(history);

    // THEN the second read tips the total over the mark and the reference goes
    expect(retained).toEqual(new Set(["3:0"]));
    // AND the reference alone sits on the mark without tripping it
    expect(retainedToolResultMediaKeys(history.slice(0, 2))).toEqual(
      new Set(["1:0"]),
    );
  });

  test("a stored image is costed at its transport size, not its stored size", () => {
    // GIVEN a 12 MB upload the send path re-encodes under the 3.5 MB
    // transport cap, followed by two 2 MB reads
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "here" }, refImage(12 * MB)],
      } as Message,
      ...toolStep("d1", "document", [inlineImage(2 * MB)]),
      ...toolStep("d2", "document", [inlineImage(2 * MB)]),
    ];

    // THEN the upload counts for about 4.7 MB on the wire and nothing is
    // evicted; at its stored 16 MB it would have evicted both reads
    expect(preModelCallSanitize(history)).toEqual(history);
  });

  test("files no adapter inlines add nothing to the total", () => {
    // GIVEN a 50 MB video, a 9 MB text file, and a 9 MB m4a the user
    // attached, none of which any adapter inlines, then two 3 MB reads
    const refsOnly = [
      {
        role: "user",
        content: [
          { type: "text", text: "here" },
          refFile("video/mp4", 50 * MB),
          refFile("text/plain", 9 * MB),
          refFile("audio/x-m4a", 9 * MB),
        ],
      } as Message,
      ...toolStep("d1", "document", [inlineImage(3 * MB)]),
      ...toolStep("d2", "document", [inlineImage(3 * MB)]),
    ];

    // THEN neither read is evicted: none of those files puts bytes on the wire
    expect(preModelCallSanitize(refsOnly)).toEqual(refsOnly);

    // AND an MP3, which adapters do inline, counts in full
    const withAudio = [
      {
        role: "user",
        content: [
          { type: "text", text: "here" },
          refFile("audio/mpeg", 9 * MB),
        ],
      } as Message,
      ...toolStep("d1", "document", [inlineImage(3 * MB)]),
      ...toolStep("d2", "document", [inlineImage(3 * MB)]),
    ];
    expect(retainedToolResultMediaKeys(withAudio)).toEqual(new Set(["4:0"]));
  });

  test("is idempotent after an eviction", () => {
    // GIVEN a history that trips the cap
    const history = documentSteps(7, 3 * MB);
    const once = preModelCallSanitize(history);

    // WHEN the projection is sanitized again (every send re-runs the bundle)
    const twice = preModelCallSanitize(once);

    // THEN nothing changes
    expect(twice).toEqual(once);
  });

  test("the before-cap key set covers evicted documents but not stale frames", () => {
    // GIVEN an old frame and five 3 MB reads, of which the cap keeps three
    const history = [
      ...toolStep("s1", undefined, [inlineImage(10)]),
      ...documentSteps(5, 3 * MB),
    ];
    expect(retainedToolResultMediaKeys(history)).toEqual(
      new Set(["7:0", "9:0", "11:0"]),
    );

    // THEN the before-cap set has every read and still omits the stale frame
    expect(retainedToolResultMediaKeysBeforeCap(history)).toEqual(
      new Set(["3:0", "5:0", "7:0", "9:0", "11:0"]),
    );
  });

  test("rewriting kept media in place shifts the cap's picks, which is why rewriters use the before-cap set", () => {
    // GIVEN five 3 MB reads with the newest three kept
    const history = documentSteps(5, 3 * MB);
    const kept = retainedToolResultMediaKeys(history);
    expect(kept).toEqual(new Set(["5:0", "7:0", "9:0"]));

    // WHEN the kept images are replaced by text, as captioning does
    const rewritten = history.map((msg, msgIdx) => ({
      ...msg,
      content: msg.content.map((block, blockIdx) =>
        block.type === "tool_result" && kept.has(`${msgIdx}:${blockIdx}`)
          ? {
              ...block,
              contentBlocks: [{ type: "text" as const, text: "[caption]" }],
            }
          : block,
      ),
    }));

    // THEN a recomputation keeps the two older reads the first pass evicted
    expect(retainedToolResultMediaKeys(rewritten)).toEqual(
      new Set(["1:0", "3:0"]),
    );
  });

  test("retained keys cover the current step's frames and kept documents only", () => {
    // GIVEN an old frame, a kept document, and a current frame
    const history = [
      ...toolStep("s1", undefined, [inlineImage(10)]),
      ...toolStep("d1", "document", [inlineImage(10)]),
      ...toolStep("s2", undefined, [inlineImage(10)]),
    ];

    // THEN the old frame is absent, the document and current frame present
    expect(retainedToolResultMediaKeys(history)).toEqual(
      new Set(["3:0", "5:0"]),
    );
  });
});
