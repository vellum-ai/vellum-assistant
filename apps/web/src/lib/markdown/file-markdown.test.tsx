/**
 * Tests for `file-markdown` helpers — the pure functions that decide whether
 * a file should be rendered as markdown and strip its leading frontmatter.
 *
 * Also covers the `<FileMarkdown>` component's `stripFrontmatter` opt-out,
 * which is required by callers that legitimately render content beginning
 * with a `---\n...\n---\n` block (e.g. LLM prompt sections).
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FileMarkdown, isMarkdown, stripFrontmatter } from "@/lib/markdown/file-markdown.js";

describe("isMarkdown", () => {
  test("matches text/markdown mime type", () => {
    expect(isMarkdown("anything", "text/markdown")).toBe(true);
  });

  test("matches .md extension regardless of casing", () => {
    expect(isMarkdown("README.md", undefined)).toBe(true);
    expect(isMarkdown("readme.MD", undefined)).toBe(true);
  });

  test("matches .markdown extension", () => {
    expect(isMarkdown("notes.markdown", undefined)).toBe(true);
  });

  test("rejects other extensions and unknown mime types", () => {
    expect(isMarkdown("script.ts", undefined)).toBe(false);
    expect(isMarkdown("install-meta.json", "application/json")).toBe(false);
    expect(isMarkdown(undefined, undefined)).toBe(false);
  });
});

describe("stripFrontmatter", () => {
  test("removes a leading YAML block", () => {
    const input = '---\nname: "Foo"\nemoji: 🚀\n---\n\n## Hello\nBody';
    expect(stripFrontmatter(input)).toBe("\n## Hello\nBody");
  });

  test("returns content unchanged when there is no frontmatter", () => {
    const input = "## Hello\nBody";
    expect(stripFrontmatter(input)).toBe(input);
  });

  test("only strips the FIRST block — later --- horizontal rules survive", () => {
    const input =
      "---\nname: x\n---\nIntro\n\n---\n\nMore content after a horizontal rule";
    expect(stripFrontmatter(input)).toBe(
      "Intro\n\n---\n\nMore content after a horizontal rule",
    );
  });

  test("handles CRLF line endings", () => {
    const input = "---\r\nname: x\r\n---\r\n\r\n## Hello";
    expect(stripFrontmatter(input)).toBe("\r\n## Hello");
  });

  test("leaves malformed frontmatter (no closing ---) untouched", () => {
    const input = "---\nname: x\nno closing\n## Hello";
    expect(stripFrontmatter(input)).toBe(input);
  });
});

describe("FileMarkdown component", () => {
  test("strips a leading frontmatter block by default", () => {
    const html = renderToStaticMarkup(
      createElement(FileMarkdown, {
        content: "---\nfoo: bar\n---\n\n# Heading\n\nBody",
      }),
    );

    // Frontmatter content does not appear in the rendered output.
    expect(html).not.toContain("foo: bar");
    // The actual heading + body do appear.
    expect(html).toContain("Heading");
    expect(html).toContain("Body");
  });

  test("preserves a leading frontmatter block when stripFrontmatter=false", () => {
    const html = renderToStaticMarkup(
      createElement(FileMarkdown, {
        content: "---\nrole: system\n---\n\n# System prompt\n\nBody",
        stripFrontmatter: false,
      }),
    );

    // Frontmatter content survives — the caller wanted it rendered.
    expect(html).toContain("role: system");
    // And the rest of the document is still present.
    expect(html).toContain("System prompt");
    expect(html).toContain("Body");
  });
});
