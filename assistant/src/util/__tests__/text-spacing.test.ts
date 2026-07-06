import { describe, expect, test } from "bun:test";

import { joinWithSpacing, needsBoundarySpace } from "../text-spacing.js";

describe("needsBoundarySpace", () => {
  test("true when both sides fuse two non-whitespace characters", () => {
    expect(needsBoundarySpace("end.", "Next")).toBe(true);
  });

  test("false when the left side already ends in whitespace", () => {
    expect(needsBoundarySpace("end. ", "Next")).toBe(false);
    expect(needsBoundarySpace("end.\n", "Next")).toBe(false);
    expect(needsBoundarySpace("end.\t", "Next")).toBe(false);
  });

  test("false when the right side already starts with whitespace", () => {
    expect(needsBoundarySpace("end.", " Next")).toBe(false);
    expect(needsBoundarySpace("end.", "\nNext")).toBe(false);
  });

  test("false when either side is empty", () => {
    expect(needsBoundarySpace("", "Next")).toBe(false);
    expect(needsBoundarySpace("end.", "")).toBe(false);
    expect(needsBoundarySpace("", "")).toBe(false);
  });
});

describe("joinWithSpacing", () => {
  test("inserts a single space between fused segments", () => {
    expect(joinWithSpacing(["Sentence one.", "Sentence two."])).toBe(
      "Sentence one. Sentence two.",
    );
  });

  test("preserves whitespace the parts already supply", () => {
    expect(joinWithSpacing(["First half. ", "Second half."])).toBe(
      "First half. Second half.",
    );
    expect(joinWithSpacing(["First.", " Second."])).toBe("First. Second.");
    expect(joinWithSpacing(["Line one\n", "Line two"])).toBe(
      "Line one\nLine two",
    );
  });

  test("does not alter intra-part spacing", () => {
    expect(joinWithSpacing(["a b c"])).toBe("a b c");
  });

  test("skips empty parts without inserting stray spaces", () => {
    expect(joinWithSpacing(["Done.", "", "More."])).toBe("Done. More.");
    expect(joinWithSpacing([])).toBe("");
  });
});
