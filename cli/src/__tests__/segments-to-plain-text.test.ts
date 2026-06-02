import { describe, test, expect } from "bun:test";
import { segmentsToPlainText } from "../lib/segments-to-plain-text.js";

describe("segmentsToPlainText", () => {
  test("returns empty string for missing or empty segments", () => {
    // GIVEN a message whose history payload carries no text segments
    // WHEN deriving its flat body
    // THEN it is the empty string (matching the daemon's old empty `content`)
    expect(segmentsToPlainText(undefined)).toBe("");
    expect(segmentsToPlainText([])).toBe("");
  });

  test("returns a single segment unchanged", () => {
    // GIVEN a plain-text message with one segment
    // WHEN deriving its flat body
    // THEN the segment is returned verbatim
    expect(segmentsToPlainText(["Real reply."])).toBe("Real reply.");
  });

  test("joins adjacent segments with a single inserted space", () => {
    // GIVEN segments split at a tool_use boundary with no surrounding whitespace
    // WHEN deriving the flat body
    // THEN a single space is inserted between them
    expect(segmentsToPlainText(["before", "after"])).toBe("before after");
  });

  test("does not double-space when either side already has whitespace", () => {
    // GIVEN segments where one side already ends/starts with whitespace
    // WHEN deriving the flat body
    // THEN no extra space is inserted (mirrors daemon joinWithSpacing)
    expect(segmentsToPlainText(["before ", "after"])).toBe("before after");
    expect(segmentsToPlainText(["before", " after"])).toBe("before after");
    expect(segmentsToPlainText(["line one\n", "line two"])).toBe(
      "line one\nline two",
    );
  });
});
