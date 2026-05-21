import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/domains/chat/components/chat-attachments/message-attachments.js", () => ({
  MessageAttachments: () => <div data-testid="attachments" />,
}));

mock.module("@/domains/chat/components/chat-markdown-message.js", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

mock.module("@/domains/chat/components/surfaces/surface-router.js", () => ({
  SurfaceRouter: ({ surface }: { surface: { surfaceId: string } }) => (
    <div data-testid="surface" data-surface-id={surface.surfaceId} />
  ),
}));

mock.module(
  "@/domains/chat/components/message-hover-actions/message-hover-actions.js",
  () => ({
    MessageHoverActions: ({ timestamp }: { timestamp?: number }) => (
      <div data-testid="hover-actions" data-timestamp={timestamp ?? ""} />
    ),
  }),
);

mock.module(
  "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card.js",
  () => ({
    ToolCallProgressCard: () => <div data-testid="tool-progress-card" />,
  }),
);

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body.js";

const noop = () => {};

function renderMessage(message: DisplayMessage): string {
  return renderToStaticMarkup(
    <TranscriptMessageBody
      message={message}
      expandedToolCallIds={new Set()}
      expandedCardIds={new Map()}
      onSurfaceAction={noop}
    />,
  );
}

describe("TranscriptMessageBody", () => {
  test("uses the latest tool completion as the message activity timestamp", () => {
    const html = renderMessage({
      stableId: "m1",
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: 1_000,
      toolCalls: [
        {
          id: "tc-1",
          toolName: "bash",
          input: {},
          status: "completed",
          startedAt: 1_500,
          completedAt: 2_000,
        },
      ],
    });

    expect(html).toContain('data-testid="hover-actions"');
    expect(html).toContain('data-timestamp="2000"');
  });

  test("falls back to the tool start time for active tool-only messages", () => {
    const html = renderMessage({
      stableId: "m1",
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: 1_000,
      toolCalls: [
        {
          id: "tc-1",
          toolName: "bash",
          input: {},
          status: "running",
          startedAt: 1_500,
        },
      ],
    });

    expect(html).toContain('data-timestamp="1500"');
  });
});
