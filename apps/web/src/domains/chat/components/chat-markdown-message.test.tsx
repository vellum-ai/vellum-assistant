/**
 * Tests for the chat-domain ChatMarkdownMessage.
 *
 * Generic rendering tests live in `packages/design-library/`. These tests cover
 * the chat-domain wrappers: OAuth popup link behaviour and workspace-path
 * linkification of inline-code spans. The workspace root is mocked here —
 * resolving it from the daemon is exercised by `useWorkspaceRoot` separately,
 * and the absolute→relative mapping by `workspace-path.test.ts`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { shouldOpenMarkdownLinkInOAuthPopup } from "@/domains/chat/utils/oauth-popup-links";

let mockRoot: string | undefined;
mock.module("@/hooks/use-workspace-root", () => ({
  useWorkspaceRoot: () => mockRoot,
}));

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

function renderChat(content: string): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ChatMarkdownMessage, { content }),
    ),
  );
}

afterEach(() => {
  mockRoot = undefined;
});

describe("ChatMarkdownMessage (OAuth link handling)", () => {
  test("detects OAuth authorization links for popup handling", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

    expect(shouldOpenMarkdownLinkInOAuthPopup(oauthUrl)).toBe(true);
    expect(shouldOpenMarkdownLinkInOAuthPopup("https://example.com/docs")).toBe(false);
    expect(shouldOpenMarkdownLinkInOAuthPopup("mailto:support@example.com")).toBe(false);
  });

  test("normal links include noopener noreferrer", () => {
    const html = renderChat("[Docs](https://example.com/docs)");

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("OAuth links omit rel to allow popup communication", () => {
    const oauthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";
    const html = renderChat(`[Connect](${oauthUrl})`);

    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });
});

describe("ChatMarkdownMessage (workspace path links)", () => {
  test("links an inline-code workspace path to the deep-linked browser", () => {
    mockRoot = "/workspace";
    const html = renderChat("Working copy at `/workspace/scratch/figma-cli/`");

    expect(html).toContain(
      'href="/assistant/workspace?path=scratch%2Ffigma-cli"',
    );
  });

  test("leaves non-workspace code spans as plain code", () => {
    mockRoot = "/workspace";
    const html = renderChat("Push it as `alice/figma-cli`");

    expect(html).toContain("<code");
    expect(html).not.toContain("/assistant/workspace?path=");
  });

  test("renders paths as plain code until the workspace root is known", () => {
    mockRoot = undefined;
    const html = renderChat("Working copy at `/workspace/scratch/figma-cli/`");

    expect(html).toContain("<code");
    expect(html).not.toContain("/assistant/workspace?path=");
  });
});
