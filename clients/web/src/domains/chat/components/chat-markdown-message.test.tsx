/**
 * Tests for the chat-domain ChatMarkdownMessage.
 *
 * Generic rendering tests live in `packages/design-library/`. These tests
 * cover the OAuth popup link behaviour and vellum:// file link handling
 * injected by the chat-domain wrapper.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shouldOpenMarkdownLinkInOAuthPopup } from "@/domains/chat/utils/oauth-popup-links";

import {
  ChatMarkdownMessage,
  isVellumLink,
} from "@/domains/chat/components/chat-markdown-message";

describe("ChatMarkdownMessage (OAuth link handling)", () => {
  test("detects OAuth authorization links for popup handling", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    expect(shouldOpenMarkdownLinkInOAuthPopup(oauthUrl)).toBe(true);
    expect(shouldOpenMarkdownLinkInOAuthPopup("https://example.com/docs")).toBe(false);
    expect(shouldOpenMarkdownLinkInOAuthPopup("mailto:support@example.com")).toBe(false);
  });

  test("normal links include noopener noreferrer", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[Docs](https://example.com/docs)",
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("OAuth links omit rel to allow popup communication", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: `[Connect](${oauthUrl})`,
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });
});

describe("isVellumLink", () => {
  test("returns true for vellum://workspace/ links", () => {
    expect(isVellumLink("vellum://workspace/scratch/report.pdf")).toBe(true);
  });

  test("returns true for vellum://host/ links", () => {
    expect(isVellumLink("vellum://host/Users/me/doc.pdf")).toBe(true);
  });

  test("returns false for unknown vellum:// authority", () => {
    expect(isVellumLink("vellum://evil/payload")).toBe(false);
  });

  test("returns false for https links", () => {
    expect(isVellumLink("https://example.com")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isVellumLink(undefined)).toBe(false);
  });
});

describe("ChatMarkdownMessage (vellum:// link handling)", () => {
  test("renders vellum:// links without target=_blank when handler provided", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[report.pdf](vellum://workspace/scratch/report.pdf)",
        onVellumLinkClick: () => {},
      }),
    );

    expect(html).toContain("report.pdf");
    expect(html).toContain("vellum://workspace/scratch/report.pdf");
    expect(html).not.toContain('target="_blank"');
  });

  test("renders vellum:// links as normal when no handler provided", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[report.pdf](vellum://workspace/scratch/report.pdf)",
      }),
    );

    expect(html).toContain("report.pdf");
    expect(html).toContain('target="_blank"');
  });

  test("renders non-vellum links normally even when handler is provided", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[Docs](https://example.com/docs)",
        onVellumLinkClick: () => {},
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
