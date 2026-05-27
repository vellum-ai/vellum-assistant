import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-attachments/message-attachments", () => ({
  MessageAttachments: () => <div data-testid="attachments" />,
}));

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

mock.module("@/domains/chat/components/surfaces/surface-router", () => ({
  SurfaceRouter: ({ surface }: { surface: { surfaceId: string } }) => (
    <div data-testid="surface" data-surface-id={surface.surfaceId} />
  ),
}));

mock.module(
  "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card",
  () => ({
    ToolCallProgressCard: () => <div data-testid="tool-progress-card" />,
  }),
);

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";

const noop = () => {};

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});

function renderMessage(
  message: DisplayMessage,
  props: {
    assistantDisplayName?: string | null;
    onInspectMessage?: (messageId: string) => void;
  } = {},
): string {
  return renderToStaticMarkup(
    <TranscriptMessageBody
      message={message}
      assistantDisplayName={props.assistantDisplayName}
      expandedToolCallIds={new Set()}
      expandedCardIds={new Map()}
      onSurfaceAction={noop}
      onInspectMessage={props.onInspectMessage}
    />,
  );
}

describe("TranscriptMessageBody", () => {
  test("uses the latest tool completion as the message activity timestamp", () => {
    const html = renderMessage({
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

    expect(html).toContain("title=");
    expect(html).toContain(":02");
  });

  test("falls back to the tool start time for active tool-only messages", () => {
    const html = renderMessage({
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

    expect(html).toContain("title=");
    expect(html).toContain(":01");
  });

  test("uses the assistant identity name for Slack assistant attribution fallback", () => {
    const html = renderMessage(
      {
        id: "m1",
        role: "assistant",
        content: "hello from Slack",
        slackMessage: {
          channelId: "C123",
          channelTs: "1710000000.000300",
          messageLink: {
            webUrl: "https://example.slack.com/archives/C123/p1710000000000300",
          },
        },
      },
      { assistantDisplayName: "Ada" },
    );

    expect(html).toContain(">Ada<");
    expect(html).not.toContain(">Assistant<");
  });

  test("passes message id to inspect handler", () => {
    const inspectedIds: string[] = [];
    const { getByTitle } = render(
      <TranscriptMessageBody
        message={{
          id: "local-1",
          role: "assistant",
          content: "hello",
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
        onInspectMessage={(messageId) => inspectedIds.push(messageId)}
      />,
    );

    fireEvent.click(getByTitle("Inspect"));
    expect(inspectedIds).toEqual(["local-1"]);
  });

  test("falls back to message id for inspect handler", () => {
    const inspectedIds: string[] = [];
    const { getByTitle } = render(
      <TranscriptMessageBody
        message={{
          id: "message-1",
          role: "user",
          content: "hello",
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
        onInspectMessage={(messageId) => inspectedIds.push(messageId)}
      />,
    );

    fireEvent.click(getByTitle("Inspect"));
    expect(inspectedIds).toEqual(["message-1"]);
  });
});
