/**
 * Tests for `FileMarkdown`. READMEs in the wild (e.g. the caveman plugin)
 * embed inline HTML for layout — centered headers, badge rows, two-column
 * tables. We render that HTML (via `rehype-raw`) rather than leaking the raw
 * tags as literal text, while `rehype-sanitize` strips anything unsafe.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FileMarkdown } from "./file-markdown";

describe("FileMarkdown", () => {
  test("renders inline HTML embedded in markdown instead of escaping it", () => {
    const html = renderToStaticMarkup(
      <FileMarkdown content={'<p align="center"><strong>hi</strong></p>'} />,
    );

    expect(html).toContain("<strong");
    expect(html).toContain("hi</strong>");
    // The literal tag must not survive as escaped text.
    expect(html).not.toContain("&lt;strong&gt;");
  });

  test("forwards sanitized presentational attributes (align/width)", () => {
    const html = renderToStaticMarkup(
      <FileMarkdown
        content={'<h1 align="center">caveman</h1>\n\n<img src="https://example.com/x.png" width="120" alt="x" />'}
      />,
    );

    expect(html).toContain('align="center"');
    expect(html).toContain('width="120"');
    expect(html).toContain('src="https://example.com/x.png"');
  });

  test("strips unsafe HTML (scripts and event handlers)", () => {
    const html = renderToStaticMarkup(
      <FileMarkdown
        content={
          '<p onclick="steal()">click</p>\n\n<script>alert(1)</script>'
        }
      />,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
  });

  test("still renders ordinary markdown", () => {
    const html = renderToStaticMarkup(
      <FileMarkdown content={"# Title\n\nSome **bold** text."} />,
    );

    expect(html).toContain("Title</h1>");
    expect(html).toContain("<strong");
    expect(html).toContain("bold");
  });
});
