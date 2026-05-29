/**
 * Smoke tests for the `Transcript` component.
 *
 * The repo doesn't run DOM-based tests (no `@testing-library/react`). We
 * verify behavior via `renderToStaticMarkup` plus `mock.module` shims that
 * replace leaf rendering dependencies with deterministic stubs.
 *
 * The component uses plain `flex-col` to render items: history items
 * appear first in DOM order (visual top, oldest first) and the
 * LatestTurnRow follows at the end of the DOM (visual bottom).
 */

import { describe, expect, mock, test } from "bun:test";

// `ChatMarkdownMessage` pulls in `react-markdown` + `remark-gfm`. They render
// fine under `renderToStaticMarkup`, but to keep these tests hermetic we
// replace it with a plain passthrough.
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

// `SurfaceRouter` fans out to many per-surface renderers; stub with a
// sentinel.
mock.module("@/components/assistant/surfaces", () => ({
  SurfaceRouter: ({ surface }: { surface: { surfaceId: string } }) => (
    <div data-testid="surface" data-surface-id={surface.surfaceId} />
  ),
}));

// `MessageHoverActions` uses `navigator.clipboard` in a handler; replace
// with a minimal stub so the server render is deterministic.
mock.module("@/domains/chat/components/message-hover-actions/message-hover-actions", () => ({
  MessageHoverActions: () => <div data-testid="hover-actions" />,
}));

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip", () => ({
  ToolCallChip: () => <div data-testid="tool-call" />,
}));

mock.module("@/domains/chat/components/chat-attachments/message-attachments", () => ({
  MessageAttachments: () => <div data-testid="attachments" />,
}));

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { Transcript } from "@/domains/chat/transcript/transcript";

function userMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role: "user",
    content,
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role: "assistant",
    content,
  };
  return { kind: "message", key: id, message: msg };
}

const noop = () => {};

describe("Transcript", () => {
  test("with empty items, renders zero rows", () => {
    const html = renderToStaticMarkup(
      <Transcript
        items={[]}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );
    // No message content → no rendered rows.
    expect(html).not.toContain('data-latest-turn="true"');
    expect(html).not.toContain('data-testid="markdown"');
  });

  test("scroll container has flex-col class (chronological order)", () => {
    const html = renderToStaticMarkup(
      <Transcript
        items={[]}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );
    expect(html).toContain("flex-col");
    expect(html).not.toContain("flex-col-reverse");
  });

  test("with trailing user message, renders history rows and a latest-turn row", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "hello"),
      userMessage("u1", "first question"),
      assistantMessage("a2", "some reply"),
      userMessage("u2", "latest question"),
      assistantMessage("a3", "streaming reply"),
    ];
    // partitionLatestTurn -> historyItems: [a1, u1, a2] (3), anchor: u2,
    //                       responseItems: [a3].
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    // All history message content appears in the rendered output.
    expect(html).toContain("hello");
    expect(html).toContain("first question");
    expect(html).toContain("some reply");

    // LatestTurnRow renders the anchor message + response items inline.
    expect(html).toContain("latest question");
    expect(html).toContain("streaming reply");

    // Marker attributes emitted by LatestTurnRow.
    expect(html).toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-edge="true"');
  });

  test("with no user messages at all, no latest-turn row is rendered", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "only assistant"),
      assistantMessage("a2", "also assistant"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    expect(html).not.toContain('data-latest-turn="true"');
    // History items still render.
    expect(html).toContain("only assistant");
    expect(html).toContain("also assistant");
  });

  test("items render in correct visual order (flex-col: history first in DOM, latest-turn last)", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "FIRST_MSG"),
      userMessage("u1", "SECOND_MSG"),
      assistantMessage("a2", "THIRD_MSG"),
    ];
    // partition: history=[a1], anchor=u1, response=[a2]
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    // In flex-col DOM order: history items come first (visual top),
    // LatestTurnRow (u1 + a2) is rendered last (visual bottom).
    const latestTurnIdx = html.indexOf('data-latest-turn="true"');
    const firstMsgIdx = html.indexOf("FIRST_MSG");
    expect(latestTurnIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThanOrEqual(0);
    // History appears first in DOM (before LatestTurnRow).
    expect(firstMsgIdx).toBeLessThan(latestTurnIdx);
  });
});

describe("Transcript avatar slot", () => {
  test("renderAvatar with no anchor (assistant-only history) still mounts the avatar at the bottom", () => {
    // No user message → no anchor. Avatar must still appear so the
    // bottom-of-conversation slot is conversation-agnostic.
    const items: TranscriptItem[] = [
      assistantMessage("a1", "only assistant"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    expect(html).not.toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("AVATAR_SLOT_MARKER");
    expect(html).toContain('data-latest-edge="true"');
  });

  test("renderAvatar with anchor: avatar appears AFTER the latest-turn cluster but BEFORE the latest-edge sentinel", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "history"),
      userMessage("u1", "ANCHOR_MARKER"),
      assistantMessage("a2", "RESPONSE_MARKER"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    const anchorIdx = html.indexOf("ANCHOR_MARKER");
    const responseIdx = html.indexOf("RESPONSE_MARKER");
    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const edgeIdx = html.indexOf('data-latest-edge="true"');

    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(responseIdx).toBeGreaterThanOrEqual(0);
    expect(avatarIdx).toBeGreaterThanOrEqual(0);
    expect(edgeIdx).toBeGreaterThanOrEqual(0);

    // anchor → response → avatar → edge sentinel
    expect(anchorIdx).toBeLessThan(responseIdx);
    expect(responseIdx).toBeLessThan(avatarIdx);
    expect(avatarIdx).toBeLessThan(edgeIdx);
  });

  test("renderAvatar omitted → no avatar slot rendered", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "question"),
      assistantMessage("a1", "reply"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    expect(html).not.toContain('data-latest-assistant-avatar="true"');
    // Latest-edge sentinel still renders because the anchor exists.
    expect(html).toContain('data-latest-edge="true"');
  });

  test("renderAvatar with neither anchor nor history → avatar still renders (empty conversation w/ avatar)", () => {
    const html = renderToStaticMarkup(
      <Transcript
        items={[]}
        conversationId={null}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("AVATAR_SLOT_MARKER");
  });
});
