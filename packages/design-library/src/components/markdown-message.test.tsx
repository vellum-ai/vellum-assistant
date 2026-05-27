/**
 * Tests for the design-library MarkdownMessage component.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * resulting HTML — no DOM testing library required.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownMessage } from "./markdown-message";

describe("MarkdownMessage", () => {
  test("root wrapper carries the chat typography token and data-slot", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "**Hi**" }),
    );

    expect(html).toContain("text-chat");
    expect(html).toContain("text-[var(--content-default)]");
    expect(html).toContain('data-slot="markdown-message"');
    expect(html).toContain("Hi");
  });

  test("heading overrides use the title + body typography scale", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "# H1\n\n## H2\n\n### H3",
      }),
    );

    expect(html).toContain("text-title-medium");
    expect(html).toContain("text-title-small");
    expect(html).toContain("text-body-medium-default");
  });

  test("tables render with the body-small typography token", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "| a | b |\n| - | - |\n| 1 | 2 |",
      }),
    );

    expect(html).toContain("text-body-small-default");
  });

  test("forwards a supplied className onto the wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "hello",
        className: "custom-wrapper-class",
      }),
    );

    expect(html).toContain("custom-wrapper-class");
    expect(html).toContain("text-chat");
  });

  test("default links include noopener noreferrer", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "[Docs](https://example.com/docs)",
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("hardLineBreaks converts single newlines to <br> tags", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "line1\nline2\n\nline3\nline4",
        hardLineBreaks: true,
      }),
    );

    expect(html).toContain("line1<br/>");
    expect(html).toContain("line3<br/>");
    expect(html).toContain("</p>");
  });

  test("without hardLineBreaks, single newlines collapse", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "line1\nline2",
      }),
    );

    expect(html).not.toContain("<br");
    expect(html).toContain("line1");
    expect(html).toContain("line2");
  });

  test("custom linkComponent replaces the default link renderer", () => {
    function CustomLink({ href, children }: { href?: string; children?: React.ReactNode }) {
      return <a href={href} data-custom="true">{children}</a>;
    }

    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "[Link](https://example.com)",
        linkComponent: CustomLink,
      }),
    );

    expect(html).toContain('data-custom="true"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });
});
