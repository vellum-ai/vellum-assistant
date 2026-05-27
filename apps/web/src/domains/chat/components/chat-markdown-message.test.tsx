/**
 * Tests for the chat-domain ChatMarkdownMessage.
 *
 * Generic rendering tests live in `packages/design-library/`. These tests
 * cover the OAuth popup link behaviour injected by the chat-domain wrapper.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { shouldOpenMarkdownLinkInOAuthPopup } from "@/domains/chat/utils/oauth-popup-links";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

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
