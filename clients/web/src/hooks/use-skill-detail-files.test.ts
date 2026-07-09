/**
 * Tests for `pickDefaultFilePath`, the pure helper backing
 * `useSkillDetailFiles`. It resolves which file path should be active given the
 * current selection, defaulting to a `SKILL.md` entry when nothing is selected.
 */

import { describe, expect, it } from "bun:test";

import {
  pickDefaultFilePath,
  type SkillFileEntry,
} from "@/hooks/use-skill-detail-files.js";

function makeEntry(overrides: Partial<SkillFileEntry> = {}): SkillFileEntry {
  return {
    name: "file.txt",
    path: "file.txt",
    size: 0,
    mimeType: "text/plain",
    isBinary: false,
    content: "",
    ...overrides,
  };
}

describe("pickDefaultFilePath", () => {
  it("returns the selected path when one is set", () => {
    const entries = [
      makeEntry({ name: "SKILL.md", path: "SKILL.md" }),
      makeEntry({ name: "other.md", path: "docs/other.md" }),
    ];

    expect(pickDefaultFilePath(entries, "docs/other.md")).toBe("docs/other.md");
  });

  it("returns the SKILL.md path when nothing is selected and it exists", () => {
    const entries = [
      makeEntry({ name: "other.md", path: "docs/other.md" }),
      makeEntry({ name: "SKILL.md", path: "SKILL.md" }),
    ];

    expect(pickDefaultFilePath(entries, null)).toBe("SKILL.md");
  });

  it("returns null when nothing is selected and there is no SKILL.md", () => {
    const entries = [makeEntry({ name: "other.md", path: "docs/other.md" })];

    expect(pickDefaultFilePath(entries, null)).toBeNull();
  });
});
