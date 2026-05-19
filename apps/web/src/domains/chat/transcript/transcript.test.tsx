/**
 * Smoke tests for the `Transcript` component.
 *
 * The repo doesn't run DOM-based tests (no `@testing-library/react`). We
 * verify behavior via `renderToStaticMarkup` plus `mock.module` shims that
 * replace leaf rendering dependencies with deterministic stubs.
 *
 * The component uses `flex-col-reverse` to render items: the LatestTurnRow
 * appears first in DOM order (visual bottom) and history items follow in
 * reverse chronological order (column-reverse un-reverses them).
 */

import { describe, expect, mock, test } from "bun:test";

// `ChatMarkdownMessage` pulls in `react-markdown` + `remark-gfm`. They render
// fine under `renderToStaticMarkup`, but to keep these tests hermetic we
// replace it with a plain passthrough.
mock.module("@/domains/chat/components/chat-markdown-message.js", () => ({
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
mock.module("@/domains/chat/components/message-hover-actions/message-hover-actions.js", () => ({
  MessageHoverActions: () => <div data-testid="hover-actions" />,
}));

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip.js", () => ({
  ToolCallChip: () => <div data-testid="tool-call" />,
}));

mock.module("@/domains/chat/components/chat-attachments/index.js", () => ({
  MessageAttachments: () => <div data-testid="attachments" />,
}));

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { TranscriptItem } from "@/domains/chat/lib/transcript/types.js";

import { Transcript } from "@/domains/chat/transcript/transcript.js";

function userMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    stableId: id,
    id,
    role: "user",
    content,
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    stableId: id,
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

  test("scroll container has flex-col-reverse class", () => {
    const html = renderToStaticMarkup(
      <Transcript
        items={[]}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );
    expect(html).toContain("flex-col-reverse");
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

  test("items render in correct visual order (column-reverse: latest-turn first in DOM, history reversed)", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "FIRST_MSG"),
      userMessage("u1", "SECOND_MSG"),
      assistantMessage("a2", "THIRD_MSG"),
    ];
    // partition: history=[a1], anchor=u1, response=[a2]
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    // In column-reverse DOM order: LatestTurnRow (u1 + a2) comes BEFORE
    // history items. History items are reversed in DOM but column-reverse
    // un-reverses them visually.
    const latestTurnIdx = html.indexOf('data-latest-turn="true"');
    const firstMsgIdx = html.indexOf("FIRST_MSG");
    expect(latestTurnIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThanOrEqual(0);
    // LatestTurnRow appears first in DOM (before history items).
    expect(latestTurnIdx).toBeLessThan(firstMsgIdx);
  });
});
