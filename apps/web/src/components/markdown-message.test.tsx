/**
 * Tests for MarkdownMessage.
 *
 * The web workspace does not load a DOM testing library, so we render to
 * static markup via `react-dom/server` and assert on the resulting HTML.
 * This is sufficient to verify that the typography tokens are emitted on
 * the outer wrapper and on heading/table overrides.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shouldOpenMarkdownLinkInOAuthPopup } from "@/domains/chat/lib/oauth-popup-links.js";

import { MarkdownMessage } from "@/components/markdown-message.js";

describe("MarkdownMessage", () => {
  test("root wrapper carries the chat typography token", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, { content: "**Hi**" }),
    );

    expect(html).toContain("text-chat");
    // Default content color token is applied.
    expect(html).toContain("text-[var(--content-default)]");
    // The markdown body still renders.
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
    // Base tokens are still present.
    expect(html).toContain("text-chat");
  });

  test("detects OAuth authorization links for popup handling", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    expect(shouldOpenMarkdownLinkInOAuthPopup(oauthUrl)).toBe(true);
    expect(shouldOpenMarkdownLinkInOAuthPopup("https://example.com/docs")).toBe(false);
    expect(shouldOpenMarkdownLinkInOAuthPopup("mailto:support@example.com")).toBe(false);
  });

  test("keeps normal links isolated with noopener", () => {
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

    // Single newlines become <br> within a paragraph.
    expect(html).toContain("line1<br/>");
    expect(html).toContain("line3<br/>");
    // Both pairs stay within their own paragraph.
    // The two paragraphs are separate <p> elements.
    expect(html).toContain("</p>");
  });

  test("without hardLineBreaks, single newlines collapse", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: "line1\nline2",
      }),
    );

    // CommonMark treats single newlines as soft breaks (space).
    expect(html).not.toContain("<br");
    expect(html).toContain("line1");
    expect(html).toContain("line2");
  });

  test("allows OAuth links to keep an opener for popup completion", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        content: `[Connect](${oauthUrl})`,
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });
});
