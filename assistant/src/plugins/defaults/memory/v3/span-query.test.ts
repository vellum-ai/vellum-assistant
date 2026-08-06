import { describe, expect, test } from "bun:test";

import { MAX_SPAN_CHUNKS, spanChunksOf } from "./span-query.js";

describe("spanChunksOf", () => {
  test("short message passes through as its clause spans", () => {
    const chunks = spanChunksOf(
      "the first sentence is here. and a second sentence follows!",
    );
    expect(chunks).toEqual([
      "the first sentence is here.",
      "and a second sentence follows!",
    ]);
  });

  test("newlines split spans like sentence punctuation", () => {
    const chunks = spanChunksOf(
      "a line without terminal punctuation\nanother line of the message",
    );
    expect(chunks).toEqual([
      "a line without terminal punctuation",
      "another line of the message",
    ]);
  });

  test("sub-15-char fragments are dropped", () => {
    const chunks = spanChunksOf("ok. this sentence is long enough to keep.");
    expect(chunks).toEqual(["this sentence is long enough to keep."]);
  });

  test("empty and whitespace-only messages yield no chunks", () => {
    expect(spanChunksOf("")).toEqual([]);
    expect(spanChunksOf("  \n\n  ")).toEqual([]);
  });

  test("fullwidth CJK terminators split without trailing whitespace", () => {
    const chunks = spanChunksOf(
      "这是消息里的第一句完整的话。这是紧跟着的第二句完整的话！第三句也一样长够十五个字符？",
    );
    expect(chunks).toEqual([
      "这是消息里的第一句完整的话。",
      "这是紧跟着的第二句完整的话！",
      "第三句也一样长够十五个字符？",
    ]);
  });

  test("non-ASCII spaced terminators split like ASCII ones", () => {
    const chunks = spanChunksOf(
      "पहला वाक्य यहाँ लिखा गया है। दूसरा वाक्य भी यहाँ मौजूद है।",
    );
    expect(chunks).toEqual([
      "पहला वाक्य यहाँ लिखा गया है।",
      "दूसरा वाक्य भी यहाँ मौजूद है।",
    ]);
  });

  test("ASCII periods still do not split decimals or dotted numbers", () => {
    expect(spanChunksOf("the value came out to 3.14159 in the final run.")) //
      .toEqual(["the value came out to 3.14159 in the final run."]);
  });

  test("a message at the cap is returned unchanged", () => {
    const sentences = Array.from(
      { length: MAX_SPAN_CHUNKS },
      (_, i) => `sentence number ${i} padded for length.`,
    );
    expect(spanChunksOf(sentences.join(" "))).toEqual(sentences);
  });

  test("over-cap messages merge into ≤cap contiguous chunks covering every span", () => {
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `sentence number ${i} padded for length.`,
    );
    const chunks = spanChunksOf(sentences.join(" "));
    expect(chunks.length).toBe(MAX_SPAN_CHUNKS);
    // Contiguous coverage: rejoining the chunks reproduces every span in order.
    expect(chunks.join(" ")).toBe(sentences.join(" "));
    // Near-equal partition: no chunk hoards spans (30/8 → sizes 3 or 4).
    for (const chunk of chunks) {
      const n = chunk.match(/sentence number/g)?.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(4);
    }
  });
});
