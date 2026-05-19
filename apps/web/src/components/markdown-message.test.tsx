/**
 * Tests for the app-level MarkdownMessage wrapper.
 *
 * Generic rendering tests live in `packages/design-library/`. These tests
 * cover the Vellum-specific OAuth popup link behaviour injected by the
 * app-layer wrapper.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shouldOpenMarkdownLinkInOAuthPopup } from "@/domains/chat/lib/oauth-popup-links.js";

import { MarkdownMessage } from "@/components/markdown-message.js";

describe("MarkdownMessage (OAuth link handling)", () => {
  test("detects OAuth authorization links for popup handling", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    expect(shouldOpenMarkdownLinkInOAuthPopup(oauthUrl)).toBe(true);
    expect(shouldOpenMarkdownLinkInOAuthPopup("https://example.com/docs")).toBe(false);
    expect(shouldOpenMarkdownLinkInOAuthPopup("mailto:support@example.com")).toBe(false);
  });

  test("normal links include noopener noreferrer", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMessage, {
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
      createElement(MarkdownMessage, {
        content: `[Connect](${oauthUrl})`,
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });
});
