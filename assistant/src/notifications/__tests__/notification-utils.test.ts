import { describe, expect, test } from "bun:test";

import { stripMarkdownForPreview } from "../notification-utils.js";

/**
 * The producer collapses whitespace after flattening, so most assertions read
 * the flattened text the way a lock screen would.
 */
function preview(value: string): string {
  return stripMarkdownForPreview(value).replace(/\s+/g, " ").trim();
}

describe("stripMarkdownForPreview", () => {
  describe("media embeds", () => {
    test("drops an embed whole, alt text included", () => {
      expect(
        preview("![vellum scene](vellum://workspace/clients/vellum-cut.mp4)"),
      ).toBe("");
    });

    test("reduces an embed-only reply to empty so the fallback is reachable", () => {
      const reply = [
        "![vellum scene](vellum://workspace/clients/web/public/cut.mp4)",
        "![hero animation](vellum://workspace/repos/hero.mp4)",
      ].join(" ");
      expect(preview(reply)).toBe("");
    });

    test("keeps the surrounding prose", () => {
      expect(
        preview("Here is the scene: ![vellum scene](vellum://workspace/a.mp4)"),
      ).toBe("Here is the scene:");
    });

    test("leaves no stray bang behind", () => {
      expect(preview("![alt](vellum://workspace/a.png)")).not.toContain("!");
    });

    test("unwraps a plain link to its text", () => {
      expect(preview("See [report.pdf](vellum://workspace/report.pdf)")).toBe(
        "See report.pdf",
      );
    });
  });

  describe("block markers", () => {
    test("drops fence lines and keeps the fenced code", () => {
      expect(preview("Fixed it:\n```ts\nconst a = 1;\n```")).toBe(
        "Fixed it: const a = 1;",
      );
    });

    test("drops heading markers", () => {
      expect(preview("## Summary\nAll green.")).toBe("Summary All green.");
    });

    test("drops blockquote markers", () => {
      expect(preview("> quoted line")).toBe("quoted line");
    });

    test("drops unordered and ordered list markers", () => {
      expect(preview("- one\n- two")).toBe("one two");
      expect(preview("1. first\n2) second")).toBe("first second");
    });

    test("drops horizontal rules", () => {
      expect(preview("before\n---\nafter")).toBe("before after");
    });
  });

  describe("tables", () => {
    test("unwraps cells and drops the delimiter row", () => {
      const table = "| Env | Key |\n|---|---|\n| dev | 4Y4L |";
      expect(preview(table)).toBe("Env Key dev 4Y4L");
    });

    test("leaves a pipe in prose alone", () => {
      expect(preview("run ls | grep foo")).toBe("run ls | grep foo");
    });
  });

  describe("what it must not touch", () => {
    test("passes plain prose through unchanged", () => {
      const prose = "Done. The deploy finished and the tests are green.";
      expect(stripMarkdownForPreview(prose)).toBe(prose);
    });

    test("preserves line structure for multi-line callers", () => {
      expect(stripMarkdownForPreview("first\n\nsecond")).toContain("\n");
    });

    test("returns empty for empty input", () => {
      expect(stripMarkdownForPreview("")).toBe("");
    });
  });
});
