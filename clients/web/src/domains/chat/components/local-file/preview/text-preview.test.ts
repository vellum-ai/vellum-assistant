import { describe, expect, test } from "bun:test";

import { truncateForDisplay } from "@/domains/chat/components/local-file/preview/text-preview";

/** The cap the preview lays out, mirrored here so the boundary is explicit. */
const CAP = 2 * 1024 * 1024;

describe("truncateForDisplay", () => {
  test("text under the cap is shown whole", () => {
    const result = truncateForDisplay("a".repeat(CAP - 1));

    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(CAP - 1);
  });

  test("text exactly at the cap is still shown whole", () => {
    const result = truncateForDisplay("a".repeat(CAP));

    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(CAP);
  });

  test("one character past the cap is cut and reported", () => {
    const result = truncateForDisplay(`${"a".repeat(CAP)}b`);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(CAP);
    expect(result.text.endsWith("b")).toBe(false);
  });

  test("an empty file is not treated as truncated", () => {
    expect(truncateForDisplay("")).toEqual({ text: "", truncated: false });
  });
});
