import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";

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
  "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card.js",
  () => ({
    ToolCallProgressCard: () => <div data-testid="tool-progress-card" />,
  }),
);

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body.js";

const noop = () => {};

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});

function renderMessage(
  message: DisplayMessage,
  props: { onInspectMessage?: (messageId: string) => void } = {},
): string {
  return renderToStaticMarkup(
    <TranscriptMessageBody
      message={message}
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

    expect(html).toContain("title=");
    expect(html).toContain(":02");
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

    expect(html).toContain("title=");
    expect(html).toContain(":01");
  });

  test("passes daemon message id to inspect handler", () => {
    const inspectedIds: string[] = [];
    const { getByTitle } = render(
      <TranscriptMessageBody
        message={{
          stableId: "stable-1",
          id: "local-1",
          daemonMessageId: "daemon-1",
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
    expect(inspectedIds).toEqual(["daemon-1"]);
  });

  test("falls back to message id for inspect handler", () => {
    const inspectedIds: string[] = [];
    const { getByTitle } = render(
      <TranscriptMessageBody
        message={{
          stableId: "stable-1",
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

  test("marks the logged-in Slack sender as You in channel conversations", () => {
    const html = renderToStaticMarkup(
      <TranscriptMessageBody
        message={{
          stableId: "stable-1",
          id: "message-1",
          role: "user",
          content: "Can @assistant take this?",
          slackMessage: {
            channelId: "C123",
            channelTs: "123.456",
            sender: {
              username: "alice",
              displayName: "Alice",
            },
          },
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
        isChannelConversation
        currentUserEmail="alice@example.com"
      />,
    );

    expect(html).toContain("You");
    expect(html).toContain("**@assistant**");
    expect(html).toContain("bg-[var(--system-positive-weak)]");
  });

  test("does not highlight mentions inside markdown code or links", () => {
    const html = renderToStaticMarkup(
      <TranscriptMessageBody
        message={{
          stableId: "stable-1",
          id: "message-1",
          role: "user",
          content: "`@code` [@link](https://example.com/@link) @plain",
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
        isChannelConversation
      />,
    );

    expect(html).toContain("`@code`");
    expect(html).toContain("[@link](https://example.com/@link)");
    expect(html).toContain("**@plain**");
    expect(html).not.toContain("**@code**");
    expect(html).not.toContain("**@link**");
  });

  test("hides Slack attribution on channel continuation messages", () => {
    const html = renderToStaticMarkup(
      <TranscriptMessageBody
        message={{
          stableId: "stable-1",
          id: "message-1",
          role: "user",
          content: "Second grouped message",
          slackMessage: {
            channelId: "C123",
            channelTs: "123.456",
            sender: {
              username: "bob",
              displayName: "Bob",
            },
          },
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
        isChannelConversation
        groupPosition="last"
      />,
    );

    expect(html).not.toContain("Bob");
    expect(html).toContain("h-2");
  });
});
