/**
 * Guards over the provider-safe ceiling on a single persisted message. The
 * cap exists because a provider rejects a request carrying one string over its
 * per-string limit (OpenAI: 10485760 bytes, `string_above_max_length`), and a
 * conversation replays its whole history every turn, so an oversized row makes
 * the conversation permanently unsendable rather than failing one turn. The
 * assertions therefore pin two properties: what lands is under the cap, and
 * the row still carries readable content.
 *
 * @see {@link https://platform.openai.com/docs/api-reference/responses/create}
 */
import { describe, expect, test } from "bun:test";

import { contentBlockArraySchema } from "../../providers/content-block-schema.js";
import type { ContentBlock } from "../../providers/types.js";
import {
  capPersistedMessageContent,
  exceedsPersistedMessageCap,
  MAX_PERSISTED_MESSAGE_BYTES,
  messageContentBytes,
} from "../message-content-cap.js";

/** The incident shape: a ~50 MB scanner result written whole into history. */
const FIFTY_MB = 50_000_000;

const ctx = {
  source: "insert",
  conversationId: "conversation-1",
  messageId: "message-1",
} as const;

function cap(content: string): string {
  return capPersistedMessageContent(content, ctx);
}

function blocksOf(content: string): ContentBlock[] {
  return contentBlockArraySchema.parse(JSON.parse(content));
}

describe("exceedsPersistedMessageCap", () => {
  test("holds the cap at 8 MB, under OpenAI's 10485760-byte per-string limit", () => {
    /** The cap has to leave headroom under the strictest provider limit. */

    // THEN the constant sits under the OpenAI per-string maximum
    expect(MAX_PERSISTED_MESSAGE_BYTES).toBe(8_000_000);
    expect(MAX_PERSISTED_MESSAGE_BYTES).toBeLessThan(10_485_760);
  });

  test("measures UTF-8 bytes, not code units", () => {
    /** Providers count bytes, so a code-unit check would pass oversized text. */

    // GIVEN text whose byte length is triple its code-unit length
    // Each euro sign is 1 code unit but 3 UTF-8 bytes, so a string a third of
    // the cap in length already fills the cap in bytes.
    const atCap = "\u20ac".repeat(Math.floor(MAX_PERSISTED_MESSAGE_BYTES / 3));
    expect(atCap.length).toBeLessThan(MAX_PERSISTED_MESSAGE_BYTES);
    expect(messageContentBytes(atCap)).toBe(MAX_PERSISTED_MESSAGE_BYTES - 2);

    // WHEN one more character pushes it past the cap in bytes only
    // THEN the check flips on the byte measurement
    expect(exceedsPersistedMessageCap(atCap)).toBe(false);
    expect(exceedsPersistedMessageCap(atCap + "\u20ac")).toBe(true);
  });
});

describe("capPersistedMessageContent", () => {
  test("returns content under the cap byte-for-byte", () => {
    /** A normal message passes through the guard unchanged. */

    // GIVEN a small message body
    const content = JSON.stringify([{ type: "text", text: "hello" }]);

    // WHEN it is capped
    // THEN it comes back identical
    expect(cap(content)).toBe(content);
  });

  test("trims a 50 MB tool result to a sendable body that keeps the pairing", () => {
    /** Tests the incident case: a ~50 MB tool result written whole. */

    // GIVEN a 50 MB tool result
    const content = JSON.stringify([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "S".repeat(FIFTY_MB),
      },
    ]);

    // WHEN it is capped
    const capped = cap(content);

    // THEN what would be persisted fits the cap
    expect(messageContentBytes(capped)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );

    // AND the head of the result plus a marker naming the original size survive
    const [block] = blocksOf(capped);
    // The row keeps its tool_result identity: dropping it would orphan the
    // paired tool_use and the provider would reject every later turn too.
    expect(block).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
    });
    const trimmed = (block as { content: string }).content;
    expect(trimmed.startsWith("SSS")).toBe(true);
    expect(trimmed).toContain(`this block was ${FIFTY_MB} bytes`);
  });

  test("trims only the oversized block and keeps the small ones whole", () => {
    /** Trimming is targeted: sibling blocks are not collateral. */

    // GIVEN a message whose oversized bytes sit in one of three blocks
    const content = JSON.stringify([
      { type: "text", text: "question" },
      { type: "thinking", thinking: "T".repeat(FIFTY_MB), signature: "sig" },
      { type: "text", text: "answer" },
    ]);

    // WHEN it is capped
    const blocks = blocksOf(cap(content));

    // THEN the result fits the cap with only the oversized block cut
    expect(messageContentBytes(JSON.stringify(blocks))).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
    expect(blocks[0]).toEqual({ type: "text", text: "question" });
    expect(blocks[2]).toEqual({ type: "text", text: "answer" });
    expect(blocks[1]).toMatchObject({ type: "thinking", signature: "sig" });
  });

  test("fits the cap when JSON escaping expands what it keeps", () => {
    /** The cap is measured on the serialized row, not on the raw text. */

    // GIVEN text that serializes to six bytes per character
    // Control characters serialize to 6 bytes each ("\u0001"), so an allowance
    // computed from raw bytes alone would serialize far over the cap.
    const content = JSON.stringify([
      { type: "text", text: "\u0001".repeat(4_000_000) },
    ]);
    expect(messageContentBytes(content)).toBeGreaterThan(
      MAX_PERSISTED_MESSAGE_BYTES,
    );

    // WHEN it is capped
    const capped = cap(content);

    // THEN the serialized result still fits, and stays a text block
    expect(messageContentBytes(capped)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
    expect(blocksOf(capped)[0]?.type).toBe("text");
  });

  test("never cuts a multi-byte character in half", () => {
    /** A byte-wise cut mid-code-point would corrupt the kept text. */

    // GIVEN oversized text made entirely of 4-byte code points
    const content = JSON.stringify([
      { type: "text", text: "\u{1f600}".repeat(FIFTY_MB / 4) },
    ]);

    // WHEN it is capped
    const text = (blocksOf(cap(content))[0] as { text: string }).text;

    // THEN the kept text holds no replacement character
    expect(text).not.toContain("\ufffd");
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  });

  test("normalizes an oversized legacy plain-string row to a text block", () => {
    /** Rows predating block serialization store a bare string. */

    // GIVEN a 50 MB legacy plain-string body
    // WHEN it is capped
    const capped = cap("L".repeat(FIFTY_MB));

    // THEN it fits the cap as a text block
    expect(messageContentBytes(capped)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
    expect(blocksOf(capped)[0]).toMatchObject({ type: "text" });
  });

  test("collapses content whose oversized bytes cannot be trimmed safely", () => {
    /** Media bytes are never sliced, so such a message collapses instead. */

    // GIVEN a message oversized on base64 image data alone
    // A truncated base64 source is a corrupt attachment rather than a smaller
    // one, so the media bytes are never sliced: the message collapses to a
    // marker instead, which keeps the row and the conversation usable.
    const content = JSON.stringify([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "A".repeat(FIFTY_MB),
        },
      },
    ]);

    // WHEN it is capped
    const capped = cap(content);

    // THEN it fits the cap as a single marker block naming the original size
    expect(messageContentBytes(capped)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
    expect(blocksOf(capped)).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          `this message body was ${messageContentBytes(content)} bytes`,
        ) as unknown as string,
      },
    ]);
  });

  test("keeps a tool result whose oversized bytes sit in its rich blocks", () => {
    /** Rich blocks are optional, so dropping them saves the result itself. */

    // GIVEN a tool result carrying its text plus an oversized image
    const content = JSON.stringify([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "scan complete",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "A".repeat(FIFTY_MB),
            },
          },
        ],
      },
    ]);

    // WHEN it is capped
    const capped = cap(content);

    // THEN it fits the cap
    expect(messageContentBytes(capped)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );

    // AND the result keeps its pairing and its own text, without the media
    expect(blocksOf(capped)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "scan complete",
      },
    ]);
  });

  test("keeps tool identity when a collapse is the only option", () => {
    /**
     * A message that loses one half of a tool pairing is rejected on every
     * later turn, which is the failure the cap exists to prevent.
     */

    // GIVEN a tool result oversized on bytes that cannot be sliced at all
    const content = JSON.stringify([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: { opaque: "A".repeat(FIFTY_MB) },
        is_error: true,
      },
    ]);

    // WHEN it is capped
    const capped = cap(content);

    // THEN the result still carries the id its tool_use is paired with
    expect(messageContentBytes(capped)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
    expect(blocksOf(capped)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: expect.stringContaining(
          "over the 8000000-byte single-message cap",
        ) as unknown as string,
        is_error: true,
      },
    ]);
  });
});
