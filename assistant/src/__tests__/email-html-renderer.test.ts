import { describe, expect, test } from "bun:test";

import { markdownToEmailHtml } from "../email/html-renderer.js";

describe("markdownToEmailHtml", () => {
  test("wraps plain text in email template", () => {
    const result = markdownToEmailHtml("Hello world");
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("<p>Hello world</p>");
    expect(result).toContain("max-width:600px");
  });

  test("converts markdown bold to <strong>", () => {
    const result = markdownToEmailHtml("This is **bold** text");
    expect(result).toContain("<strong>bold</strong>");
  });

  test("converts markdown links", () => {
    const result = markdownToEmailHtml("Visit [Vellum](https://vellum.ai)");
    expect(result).toContain('<a href="https://vellum.ai">Vellum</a>');
  });

  test("converts markdown lists", () => {
    const result = markdownToEmailHtml("- item one\n- item two\n- item three");
    expect(result).toContain("<li>item one</li>");
    expect(result).toContain("<li>item two</li>");
    expect(result).toContain("<ul>");
  });

  test("converts markdown code blocks", () => {
    const result = markdownToEmailHtml("```\nconsole.log('hi')\n```");
    expect(result).toContain("<code>");
    expect(result).toContain("console.log(");
  });

  test("converts line breaks (GFM breaks mode)", () => {
    const result = markdownToEmailHtml("line one\nline two");
    expect(result).toContain("<br>");
  });

  test("returns raw HTML input as-is", () => {
    const rawHtml = "<div>Already HTML</div>";
    const result = markdownToEmailHtml(rawHtml);
    expect(result).toBe(rawHtml);
  });

  test("handles empty string", () => {
    const result = markdownToEmailHtml("");
    expect(result).toBe("");
  });

  test("handles multiline markdown email", () => {
    const md = `Hi there,

Thanks for reaching out! Here's what I found:

1. **First point** — some details
2. **Second point** — more details

Let me know if you need anything else.

Best,
Assistant`;

    const result = markdownToEmailHtml(md);
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("<strong>First point</strong>");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>");
  });
});
