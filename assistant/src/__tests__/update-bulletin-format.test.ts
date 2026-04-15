import { describe, expect, test } from "bun:test";

import {
  appendReleaseBlock,
  extractReleaseIds,
  filterNewContentBlocks,
  hasReleaseBlock,
  releaseMarker,
} from "../prompts/update-bulletin-format.js";

describe("releaseMarker", () => {
  test("returns an HTML comment with the version embedded", () => {
    expect(releaseMarker("1.2.3")).toBe("<!-- vellum-update-release:1.2.3 -->");
  });

  test("handles pre-release / build-metadata versions", () => {
    expect(releaseMarker("2.0.0-beta.1+build.42")).toBe(
      "<!-- vellum-update-release:2.0.0-beta.1+build.42 -->",
    );
  });
});

describe("hasReleaseBlock", () => {
  const content = [
    "<!-- vellum-update-release:1.0.0 -->",
    "## 1.0.0",
    "Initial release.",
    "",
    "<!-- vellum-update-release:1.1.0 -->",
    "## 1.1.0",
    "Second release.",
  ].join("\n");

  test("returns true when the marker is present", () => {
    expect(hasReleaseBlock(content, "1.0.0")).toBe(true);
    expect(hasReleaseBlock(content, "1.1.0")).toBe(true);
  });

  test("returns false when the marker is absent", () => {
    expect(hasReleaseBlock(content, "2.0.0")).toBe(false);
  });

  test("returns false for empty content", () => {
    expect(hasReleaseBlock("", "1.0.0")).toBe(false);
  });
});

describe("appendReleaseBlock", () => {
  test("appends to empty content", () => {
    const result = appendReleaseBlock(
      "",
      "1.0.0",
      "## 1.0.0\nInitial release.",
    );
    expect(result).toBe(
      "<!-- vellum-update-release:1.0.0 -->\n## 1.0.0\nInitial release.\n",
    );
  });

  test("preserves prior blocks when appending", () => {
    const existing = "<!-- vellum-update-release:1.0.0 -->\n## 1.0.0\nFirst.\n";
    const result = appendReleaseBlock(existing, "1.1.0", "## 1.1.0\nSecond.");

    // Prior block is untouched
    expect(result).toContain("<!-- vellum-update-release:1.0.0 -->");
    expect(result).toContain("## 1.0.0\nFirst.");

    // New block is appended
    expect(result).toContain("<!-- vellum-update-release:1.1.0 -->");
    expect(result).toContain("## 1.1.0\nSecond.");

    // New block comes after old block
    const oldIdx = result.indexOf("<!-- vellum-update-release:1.0.0 -->");
    const newIdx = result.indexOf("<!-- vellum-update-release:1.1.0 -->");
    expect(newIdx).toBeGreaterThan(oldIdx);
  });

  test("inserts separator when existing content lacks trailing newline", () => {
    const existing = "<!-- vellum-update-release:1.0.0 -->\nFirst.";
    const result = appendReleaseBlock(existing, "1.1.0", "Second.");

    // Double newline separates the blocks when there was no trailing newline
    expect(result).toContain("First.\n\n<!-- vellum-update-release:1.1.0 -->");
  });
});

describe("filterNewContentBlocks", () => {
  const blockA = [
    "<!-- vellum-update-release:entry-a -->",
    "## Entry A",
    "Content for A.",
    "<!-- /vellum-update-release:entry-a -->",
  ].join("\n");

  const blockB = [
    "<!-- vellum-update-release:entry-b -->",
    "## Entry B",
    "Content for B.",
    "<!-- /vellum-update-release:entry-b -->",
  ].join("\n");

  const blockC = [
    "<!-- vellum-update-release:entry-c -->",
    "## Entry C",
    "Content for C.",
    "<!-- /vellum-update-release:entry-c -->",
  ].join("\n");

  test("returns body unchanged when no block structure exists", () => {
    const body = "## What's New\n\nPlain text notes.\n";
    expect(filterNewContentBlocks(body, "anything")).toBe(body);
  });

  test("returns all blocks when none are present in existing content", () => {
    const body = `${blockA}\n\n${blockB}`;
    const result = filterNewContentBlocks(body, "no markers here");
    expect(result).toContain("entry-a");
    expect(result).toContain("entry-b");
  });

  test("returns empty string when all blocks are already present", () => {
    const body = `${blockA}\n\n${blockB}`;
    const existing = `<!-- vellum-update-release:0.9.0 -->\n${blockA}\n\n${blockB}\n`;
    expect(filterNewContentBlocks(body, existing)).toBe("");
  });

  test("returns only new blocks when some are already present", () => {
    const body = `${blockA}\n\n${blockB}\n\n${blockC}`;
    const existing = `<!-- vellum-update-release:0.9.0 -->\n${blockA}\n\n${blockB}\n`;

    const result = filterNewContentBlocks(body, existing);
    expect(result).toContain("entry-c");
    expect(result).toContain("Content for C.");
    expect(result).not.toContain("entry-a");
    expect(result).not.toContain("entry-b");
  });

  test("handles single-block template", () => {
    const result = filterNewContentBlocks(blockA, "no markers");
    expect(result).toContain("entry-a");
    expect(result).toContain("Content for A.");
  });
});

describe("extractReleaseIds", () => {
  test("returns all version strings from multiple markers", () => {
    const content = [
      "<!-- vellum-update-release:1.0.0 -->",
      "Block one.",
      "<!-- vellum-update-release:1.1.0 -->",
      "Block two.",
      "<!-- vellum-update-release:2.0.0-rc.1 -->",
      "Block three.",
    ].join("\n");

    expect(extractReleaseIds(content)).toEqual([
      "1.0.0",
      "1.1.0",
      "2.0.0-rc.1",
    ]);
  });

  test("returns empty array for empty content", () => {
    expect(extractReleaseIds("")).toEqual([]);
  });

  test("returns empty array when no markers are present", () => {
    expect(extractReleaseIds("Just some text\nwith no markers.")).toEqual([]);
  });

  test("handles duplicate markers", () => {
    const content = [
      "<!-- vellum-update-release:1.0.0 -->",
      "Block one.",
      "<!-- vellum-update-release:1.0.0 -->",
      "Duplicate block.",
    ].join("\n");

    expect(extractReleaseIds(content)).toEqual(["1.0.0", "1.0.0"]);
  });
});
