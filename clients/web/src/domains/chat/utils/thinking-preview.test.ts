import { describe, expect, test } from "bun:test";

import { thinkingPreview } from "./thinking-preview";

describe("thinkingPreview", () => {
  test("extracts just the headline from a bold-headlined summary", () => {
    expect(
      thinkingPreview(
        "**Considering formatting options** I'm pondering how to present information effectively.",
      ),
    ).toBe("Considering formatting options");
  });

  test("ignores bold markers past the headline", () => {
    expect(
      thinkingPreview("**Planning edits** I need to run **several** checks."),
    ).toBe("Planning edits");
  });

  test("passes text without a leading headline through unchanged", () => {
    expect(thinkingPreview("Reading adidas-group.com")).toBe(
      "Reading adidas-group.com",
    );
  });

  test("tolerates leading whitespace before the headline", () => {
    expect(thinkingPreview("\n**Clarifying table details** body")).toBe(
      "Clarifying table details",
    );
  });

  test("strips the marker while the headline is still streaming", () => {
    expect(thinkingPreview("**Considering fo")).toBe("Considering fo");
  });

  test("falls back to the raw text when the headline is empty", () => {
    expect(thinkingPreview("**** body text")).toBe("**** body text");
  });

  test("only uses the first headline of a merged multi-block segment", () => {
    expect(
      thinkingPreview("**First block** body\n**Second block** more body"),
    ).toBe("First block");
  });
});
