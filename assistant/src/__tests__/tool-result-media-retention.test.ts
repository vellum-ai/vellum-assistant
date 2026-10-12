import { describe, expect, test } from "bun:test";

import {
  preModelCallSanitize,
  retainedToolResultMediaKeys,
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
    // GIVEN the 14 MB high / 9 MB low band and 3 MB reads

    // WHEN four reads total 12 MB
    const four = documentSteps(4, 3 * MB);
    // THEN nothing is evicted
    expect(preModelCallSanitize(four)).toEqual(four);

    // WHEN a fifth read pushes the total to 15 MB
    const five = documentSteps(5, 3 * MB);
    const sentFive = preModelCallSanitize(five);
    // THEN the two oldest are evicted (15 -> 12 -> 9 MB, at the low mark)
    expect(retainedToolResultMediaKeys(five)).toEqual(
      new Set(["5:0", "7:0", "9:0"]),
    );
    const evicted = toolResult(sentFive, 1);
    expect(hasMedia(evicted)).toBe(false);
    expect(evicted.content).toStartWith("loaded d1");
    expect(evicted.content).toContain("payload limit");
    expect(evicted.content).toContain("Call the tool again");

    // WHEN a sixth read arrives (9 + 3 = 12 MB, under the high mark)
    const six = documentSteps(6, 3 * MB);
    const sentSix = preModelCallSanitize(six);
    // THEN no new eviction happens and the earlier prefix is byte-identical,
    // so the prompt cache holds between crossings
    expect(retainedToolResultMediaKeys(six)).toEqual(
      new Set(["5:0", "7:0", "9:0", "11:0"]),
    );
    expect(JSON.stringify(sentSix.slice(0, five.length))).toBe(
      JSON.stringify(sentFive),
    );

    // WHEN a seventh read crosses the high mark again (15 MB)
    const seven = documentSteps(7, 3 * MB);
    // THEN the next two oldest go
    expect(retainedToolResultMediaKeys(seven)).toEqual(
      new Set(["9:0", "11:0", "13:0"]),
    );
  });

  test("a crossing never evicts the step that caused it", () => {
    // GIVEN a single read far above the high mark on its own
    const alone = documentSteps(1, 30 * MB);
    // THEN it is still sent
    expect(preModelCallSanitize(alone)).toEqual(alone);

    // GIVEN a small read followed by a huge one
    const history = [
      ...toolStep("d1", "document", [inlineImage(1 * MB)]),
      ...toolStep("d2", "document", [inlineImage(30 * MB)]),
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
    // GIVEN a 10 MB user upload followed by two 3 MB reads
    const upload: Message = {
      role: "user",
      content: [{ type: "text", text: "here" }, inlineImage(10 * MB)],
    };
    const history = [
      upload,
      ...toolStep("d1", "document", [inlineImage(3 * MB)]),
      ...toolStep("d2", "document", [inlineImage(3 * MB)]),
    ];

    // WHEN sanitized (13 MB fits under the 14 MB mark, 16 MB does not)
    const sent = preModelCallSanitize(history);

    // THEN the upload is intact, the older read is evicted, the newer read kept
    expect(sent[0]).toEqual(upload);
    expect(hasMedia(toolResult(sent, 2))).toBe(false);
    expect(hasMedia(toolResult(sent, 4))).toBe(true);
  });

  test("a persisted reference is costed at its base64 size on the wire", () => {
    // GIVEN a 10.5 MB reference (14 MB as base64, exactly the high mark) and
    // a 4-byte inline read after it
    const history = [
      ...toolStep("d1", "document", [refImage(10.5 * MB)]),
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

  test("is idempotent after an eviction", () => {
    // GIVEN a history that trips the cap
    const history = documentSteps(7, 3 * MB);
    const once = preModelCallSanitize(history);

    // WHEN the projection is sanitized again (every send re-runs the bundle)
    const twice = preModelCallSanitize(once);

    // THEN nothing changes
    expect(twice).toEqual(once);
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
