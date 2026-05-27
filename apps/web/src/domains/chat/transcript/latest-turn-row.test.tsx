/**
 * Static-markup tests for `LatestTurnRow`'s avatar slot behavior.
 *
 * The repo doesn't run DOM-based tests (no `@testing-library/react`). We
 * exercise the component via `renderToStaticMarkup` and mock the LEAF
 * rendering deps (`ChatMarkdownMessage`, `MessageHoverActions`, `ToolCallChip`,
 * `surfaces`, `ChatAttachments`) so the real `TranscriptRow` runs and
 * produces queryable text content. We deliberately do NOT mock
 * `./TranscriptRow` — `mock.module()` is process-global in bun:test and
 * stubbing TranscriptRow at the module level here leaks into other test
 * files (e.g. `Transcript.test.tsx`) that still need the real component.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

mock.module("@/domains/chat/components/message-hover-actions/message-hover-actions", () => ({
  MessageHoverActions: () => <div data-testid="hover-actions" />,
}));

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip", () => ({
  ToolCallChip: () => <div data-testid="tool-call-chip" />,
}));

mock.module("@/components/assistant/surfaces", () => ({
  SurfaceRouter: () => <div data-testid="surface-router" />,
}));

mock.module("@/domains/chat/components/chat-attachments/message-attachments", () => ({
  MessageAttachments: () => <div data-testid="message-attachments" />,
}));

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type {
  MessageItem,
  ThinkingItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { LatestTurnRow } from "@/domains/chat/transcript/latest-turn-row";

function userMessageItem(id: string, content: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "user",
    content,
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessageItem(id: string, content: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "assistant",
    content,
  };
  return { kind: "message", key: id, message: msg };
}

function thinkingItem(id: string): ThinkingItem {
  return { kind: "thinking", key: id };
}

const noop = () => {};

const sharedProps = {
  viewportMinHeight: 0,
  expandedToolCallIds: new Set<string>(),
  expandedCardIds: new Map<string, boolean>(),
  onSurfaceAction: noop,
  onSecretSubmit: noop,
  onConfirmationDecision: noop,
  onRetryError: noop,
};

describe("LatestTurnRow avatar slot", () => {
  test("with no avatarSlot → no avatar marker is rendered", () => {
    const anchor = userMessageItem("u1", "hello");
    const responseItems: TranscriptItem[] = [
      assistantMessageItem("a1", "hi back"),
    ];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        {...sharedProps}
      />,
    );
    expect(html).not.toContain('data-latest-assistant-avatar="true"');
  });

  test("with avatarSlot + responseItems ending in an assistant message → exactly one marker, after the assistant row", () => {
    const anchor = userMessageItem("u1", "question");
    const responseItems: TranscriptItem[] = [
      thinkingItem("t1"),
      assistantMessageItem("a1", "ASSISTANT_REPLY_MARKER"),
    ];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        avatarSlot={<span data-testid="avatar-stub">AVATAR_SLOT_MARKER</span>}
        {...sharedProps}
      />,
    );
    const matches = html.match(/data-latest-assistant-avatar="true"/g) ?? [];
    expect(matches.length).toBe(1);

    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const assistantIdx = html.indexOf("ASSISTANT_REPLY_MARKER");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    // Avatar appears after the assistant row's content in HTML order.
    expect(avatarIdx).toBeGreaterThan(assistantIdx);
    // The avatarSlot itself is rendered.
    expect(html).toContain("AVATAR_SLOT_MARKER");
  });

  test("with multiple assistant messages and non-assistant items between → marker is after the LAST assistant row", () => {
    const anchor = userMessageItem("u1", "question");
    const responseItems: TranscriptItem[] = [
      assistantMessageItem("a1", "FIRST_REPLY_MARKER"),
      thinkingItem("t1"),
      assistantMessageItem("a2", "SECOND_REPLY_MARKER"),
      thinkingItem("t2"),
    ];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        avatarSlot={<span>AVATAR</span>}
        {...sharedProps}
      />,
    );

    const matches = html.match(/data-latest-assistant-avatar="true"/g) ?? [];
    expect(matches.length).toBe(1);

    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const firstReplyIdx = html.indexOf("FIRST_REPLY_MARKER");
    const secondReplyIdx = html.indexOf("SECOND_REPLY_MARKER");

    // After the second (last) assistant row's content.
    expect(avatarIdx).toBeGreaterThan(secondReplyIdx);
    // Definitely not just after the first.
    expect(avatarIdx).toBeGreaterThan(firstReplyIdx);
    // The first reply precedes the second (sanity check).
    expect(firstReplyIdx).toBeLessThan(secondReplyIdx);
  });

  test("with avatarSlot + responseItems with no assistant message (only thinking) → marker appears once after all responseItems", () => {
    const anchor = userMessageItem("u1", "question");
    const responseItems: TranscriptItem[] = [thinkingItem("t1")];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        avatarSlot={<span>AVATAR</span>}
        {...sharedProps}
      />,
    );

    const matches = html.match(/data-latest-assistant-avatar="true"/g) ?? [];
    expect(matches.length).toBe(1);

    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const edgeIdx = html.indexOf('data-latest-edge="true"');
    expect(edgeIdx).toBeGreaterThanOrEqual(0);
    // Avatar comes before the edge sentinel.
    expect(avatarIdx).toBeLessThan(edgeIdx);
  });

  test("with avatarSlot + empty responseItems → avatar still renders so it persists across the user-send → response boundary without flicker", () => {
    const anchor = userMessageItem("u1", "question");
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={[]}
        avatarSlot={<span>AVATAR_SLOT_MARKER</span>}
        {...sharedProps}
      />,
    );
    // After a user sends, the new user message becomes the anchor and
    // responseItems is empty until V streams. Keeping the avatar
    // mounted in this window prevents the ChatAvatar entrance spring
    // from replaying as a visible flicker.
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("AVATAR_SLOT_MARKER");
  });
});

describe("LatestTurnRow spacer position", () => {
  test("flex-1 spacer appears AFTER responses (fills remaining viewport height below content)", () => {
    const anchor = userMessageItem("u1", "ANCHOR_CONTENT");
    const responseItems: TranscriptItem[] = [
      assistantMessageItem("a1", "RESPONSE_CONTENT"),
    ];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        {...sharedProps}
      />,
    );

    const anchorIdx = html.indexOf("ANCHOR_CONTENT");
    const responseIdx = html.indexOf("RESPONSE_CONTENT");
    const edgeIdx = html.indexOf('data-latest-edge="true"');

    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(responseIdx).toBeGreaterThanOrEqual(0);
    expect(edgeIdx).toBeGreaterThanOrEqual(0);

    // Anchor first, then response, then edge sentinel at the very end.
    expect(anchorIdx).toBeLessThan(responseIdx);
    expect(responseIdx).toBeLessThan(edgeIdx);
  });
});
