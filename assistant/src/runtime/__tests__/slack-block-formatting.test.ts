/**
 * Unit tests for `splitLongTextSegment` — the pure helper that slices a
 * string into Slack-section-sized chunks while preferring natural
 * boundaries (paragraph → newline → sentence → hard slice).
 *
 * Also covers `textToSlackBlocks` integration for the long-text splitting
 * path.
 */

import { describe, expect, test } from "bun:test";

import {
  SLACK_SECTION_MAX_CHARS,
  splitLongTextSegment,
  textToSlackBlocks,
} from "../slack-block-formatting.js";

describe("splitLongTextSegment", () => {
  test("returns single-element array for text under the limit", () => {
    const text = "short message";
    const chunks = splitLongTextSegment(text);
    expect(chunks).toEqual([text]);
  });

  test("returns single-element array for text exactly at the limit", () => {
    const text = "a".repeat(SLACK_SECTION_MAX_CHARS);
    const chunks = splitLongTextSegment(text);
    expect(chunks).toEqual([text]);
  });

  test("splits 5000-char paragraph-only text into ≥ 2 chunks under the limit and reconstructs input", () => {
    // Build enough paragraphs (~50 chars each + "\n\n" separators) to
    // comfortably exceed 5000 chars.
    const paragraphs: string[] = [];
    for (let i = 0; i < 120; i++) {
      paragraphs.push(`Paragraph number ${i} with filler content here.`);
    }
    const text = paragraphs.join("\n\n");
    expect(text.length).toBeGreaterThanOrEqual(5000);

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS);
    }

    // Joining chunks with empty string should recover all non-whitespace
    // content (the helper trims chunk boundaries, so inter-chunk "\n\n"
    // separators may be collapsed). Compare whitespace-stripped.
    const rejoined = chunks.join("").replace(/\s+/g, "");
    const original = text.replace(/\s+/g, "");
    expect(rejoined).toBe(original);
  });

  test("splits on paragraph boundary rather than mid-sentence", () => {
    // Two paragraphs where a paragraph split is available inside the
    // first window. Use maxChars large enough that the first paragraph
    // fits, but both together don't.
    const firstParagraph = "a".repeat(2000);
    const secondParagraph = "b".repeat(2000);
    const text = `${firstParagraph}\n\n${secondParagraph}`;

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(firstParagraph);
    expect(chunks[1]).toBe(secondParagraph);
  });

  test("splits text with no paragraph or sentence boundaries via hard slice", () => {
    const text = "x".repeat(10_000);
    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBeGreaterThanOrEqual(
      Math.ceil(10_000 / SLACK_SECTION_MAX_CHARS),
    );
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS);
    }

    // No content lost.
    expect(chunks.join("")).toBe(text);
  });

  test("respects custom maxChars parameter", () => {
    const text = "a".repeat(100);
    const chunks = splitLongTextSegment(text, 30);

    expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(100 / 30));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("prefers sentence boundary when no paragraph or newline is available", () => {
    const sentenceA = "This is sentence A. ".repeat(100); // ~2000 chars
    const sentenceB = "This is sentence B. ".repeat(100); // ~2000 chars
    const text = sentenceA + sentenceB;

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS);
      // Each chunk should end with a period (sentence-aligned split).
      expect(chunk.endsWith(".")).toBe(true);
    }
  });

  test("prefers single newline over sentence boundary when no paragraph is present", () => {
    const lineA = "a".repeat(1500);
    const lineB = "b".repeat(1500);
    const text = `${lineA}\n${lineB}`;

    const chunks = splitLongTextSegment(text);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(lineA);
    expect(chunks[1]).toBe(lineB);
  });
});

describe("textToSlackBlocks long-text splitting", () => {
  test("5000-char prose input produces multiple section blocks, each ≤ 3000 chars", () => {
    // Build ≥ 5000 chars of prose with paragraph boundaries so the splitter
    // has natural cut points.
    const paragraphs: string[] = [];
    for (let i = 0; i < 120; i++) {
      paragraphs.push(`Paragraph number ${i} with filler content here.`);
    }
    const text = paragraphs.join("\n\n");
    expect(text.length).toBeGreaterThanOrEqual(5000);

    const blocks = textToSlackBlocks(text);
    expect(blocks).toBeDefined();

    const sectionBlocks = blocks!.filter((b) => b.type === "section");
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(2);

    for (const block of sectionBlocks) {
      // Cast: filter() narrows to section blocks but TS may not
      // follow the discriminant narrowing through filter.
      const section = block as { type: "section"; text: { text: string } };
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  test("2000-char prose input (under the limit) produces a single section block", () => {
    const text = "a".repeat(2000);
    const blocks = textToSlackBlocks(text);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(1);
    expect(blocks![0].type).toBe("section");
  });

  test("does not split a markdown link across section blocks when the link text contains a sentence boundary near maxChars", () => {
    // Craft prose so the last `. ` (sentence boundary) inside the first
    // `SLACK_SECTION_MAX_CHARS` window falls INSIDE a markdown link's text.
    // If `splitLongTextSegment` ran on raw markdown, it would cut the link
    // in half — chunk 1 would end with `[First sentence. ` and chunk 2 would
    // start with `Second sentence](https://example.com)`, leaving orphan
    // `](` tokens that never get converted to Slack mrkdwn and leak raw
    // markdown to Slack.
    //
    // By transforming to mrkdwn FIRST (so the link becomes
    // `<url|First sentence. Second sentence>`), the splitter can no longer
    // land on the `. ` inside the `|...>` span in a way that produces orphan
    // markdown tokens — and `](` never appears in any chunk.
    const linkMarkdown =
      "[First sentence. Second sentence](https://example.com)";
    // Fill the first window with sentence-delimited filler so there is a
    // valid `. ` split point available and the link straddles the boundary.
    const prefix = "Filler sentence. ".repeat(170); // ≈ 2890 chars
    // Pad the remainder so the total length comfortably exceeds the limit.
    const suffix = " Trailing sentence. ".repeat(100);
    const text = prefix + linkMarkdown + suffix;
    expect(text.length).toBeGreaterThan(SLACK_SECTION_MAX_CHARS);

    const blocks = textToSlackBlocks(text);
    expect(blocks).toBeDefined();

    const sectionBlocks = blocks!.filter((b) => b.type === "section") as Array<{
      type: "section";
      text: { type: string; text: string };
    }>;
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(2);

    for (const section of sectionBlocks) {
      // Every section block must be well-formed Slack mrkdwn: no raw
      // markdown-link tokens should leak through.
      expect(section.text.text).not.toContain("](");
      expect(section.text.text).not.toContain("[First sentence");
      // No orphan `**` bold markers.
      expect(section.text.text).not.toContain("**");
      // Section must respect Slack's 3000-char ceiling.
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
    }

    // The link should be rendered exactly once as Slack mrkdwn across all
    // blocks — not duplicated, not broken apart.
    const combined = sectionBlocks.map((s) => s.text.text).join("\n");
    expect(combined).toContain(
      "<https://example.com|First sentence. Second sentence>",
    );
  });

  test("does not split a **bold** span across section blocks when the bold text contains a sentence boundary near maxChars", () => {
    // Same shape as the link-straddle test, but for `**bold**`. If splitting
    // ran on raw markdown, the splitter would land on a `. ` inside the bold
    // span, leaving chunk 1 with `**First sentence. ` (orphan `**` opener)
    // and chunk 2 with `Second sentence**` (orphan `**` closer). Both
    // chunks' mrkdwn regexes would fail to match, leaking raw `**` tokens.
    const boldMarkdown = "**First sentence. Second sentence**";
    const prefix = "Filler sentence. ".repeat(170); // ≈ 2890 chars
    const suffix = " Trailing sentence. ".repeat(100);
    const text = prefix + boldMarkdown + suffix;
    expect(text.length).toBeGreaterThan(SLACK_SECTION_MAX_CHARS);

    const blocks = textToSlackBlocks(text);
    expect(blocks).toBeDefined();

    const sectionBlocks = blocks!.filter((b) => b.type === "section") as Array<{
      type: "section";
      text: { type: string; text: string };
    }>;
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(2);

    for (const section of sectionBlocks) {
      // No orphan `**` bold markers should survive.
      expect(section.text.text).not.toContain("**");
      // No orphan link tokens either (defense in depth — this test focuses
      // on bold, but the shared fix should protect both).
      expect(section.text.text).not.toContain("](");
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
    }

    // The bold span should be rendered exactly once as Slack single-asterisk
    // bold across all blocks.
    const combined = sectionBlocks.map((s) => s.text.text).join("\n");
    expect(combined).toContain("*First sentence. Second sentence*");
  });

  test("4000-char paragraph followed by header and second paragraph preserves ordering", () => {
    const firstParagraph = "a".repeat(4000);
    const secondParagraph = "short second paragraph.";
    const text = `${firstParagraph}\n\n# My Header\n\n${secondParagraph}`;

    const blocks = textToSlackBlocks(text);
    expect(blocks).toBeDefined();

    // Locate the header block — it must exist and not be absorbed into
    // the long-text split.
    const headerIndices = blocks!
      .map((b, i) => (b.type === "header" ? i : -1))
      .filter((i) => i >= 0);
    expect(headerIndices.length).toBe(1);
    const headerIndex = headerIndices[0];

    const headerBlock = blocks![headerIndex] as {
      type: "header";
      text: { text: string };
    };
    expect(headerBlock.text.text).toBe("My Header");

    // Before the header: at least one section block (from the 4000-char
    // paragraph, which should split into ≥ 2 sections).
    const beforeHeader = blocks!.slice(0, headerIndex);
    const sectionsBeforeHeader = beforeHeader.filter(
      (b) => b.type === "section",
    );
    expect(sectionsBeforeHeader.length).toBeGreaterThanOrEqual(2);

    // After the header: at least one section block (the second paragraph).
    const afterHeader = blocks!.slice(headerIndex + 1);
    const sectionsAfterHeader = afterHeader.filter(
      (b) => b.type === "section",
    );
    expect(sectionsAfterHeader.length).toBeGreaterThanOrEqual(1);

    // Every section block stays under Slack's 3000-char ceiling.
    for (const block of blocks!) {
      if (block.type === "section") {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
    }
  });
});
