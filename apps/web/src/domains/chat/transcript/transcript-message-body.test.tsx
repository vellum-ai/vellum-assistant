import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-attachments/message-attachments", () => ({
  MessageAttachments: () => <div data-testid="attachments" />,
}));

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({
    content,
    hardLineBreaks,
  }: {
    content: string;
    hardLineBreaks?: boolean;
  }) => (
    <div
      data-testid="markdown"
      data-hard-line-breaks={hardLineBreaks ? "true" : "false"}
    >
      {content}
    </div>
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
    ToolCallProgressCard: ({
      autoExpand,
      toolCalls,
    }: {
      autoExpand?: boolean;
      toolCalls: Array<{ id: string }>;
    }) => (
      <div
        data-testid="tool-progress-card"
        data-auto-expand={autoExpand ? "true" : "false"}
        data-tool-call-ids={toolCalls.map((tc) => tc.id).join(",")}
      />
    ),
  }),
);

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { Surface } from "@/domains/chat/types/types";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import { buildTurnActivity } from "@/domains/chat/transcript/turn-activity";

import { textBody } from "@/domains/chat/utils/message-test-helpers";
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
    isStreaming?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <TranscriptMessageBody
      message={message}
      assistantDisplayName={props.assistantDisplayName}
      expandedToolCallIds={new Set()}
      expandedCardIds={new Map()}
      expandedThinkingKeys={new Map()}
      onSurfaceAction={noop}
      onInspectMessage={props.onInspectMessage}
      isStreaming={props.isStreaming}
    />,
  );
}

describe("TranscriptMessageBody", () => {
  test("enables hard line breaks for assistant messages (JARVIS-1007)", () => {
    const html = renderMessage({
      id: "m1",
      role: "assistant",
      ...textBody("line one\nline two"),
      timestamp: 1_000,
    });

    expect(html).toContain('data-hard-line-breaks="true"');
  });

  test("enables hard line breaks for user messages too", () => {
    const html = renderMessage({
      id: "m1",
      role: "user",
      ...textBody("line one\nline two"),
      timestamp: 1_000,
    });

    expect(html).toContain('data-hard-line-breaks="true"');
  });

  test("uses the latest tool completion as the message activity timestamp", () => {
    const html = renderMessage({
      id: "m1",
      role: "assistant",
      ...textBody(""),
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
      ...textBody(""),
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
        ...textBody("hello from Slack"),
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

  test("renders an explicit Open in Slack hover action for Slack messages", () => {
    const { getByRole } = render(
      <TranscriptMessageBody
        message={{
          id: "slack-1",
          role: "assistant",
          ...textBody("Slack context"),
          slackMessage: {
            channelId: "C123",
            channelTs: "1710000000.000300",
            messageLink: {
              webUrl:
                "https://example.slack.com/archives/C123/p1710000000000300",
            },
          },
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      getByRole("link", { name: "Open in Slack" }).getAttribute("href"),
    ).toBe("https://example.slack.com/archives/C123/p1710000000000300");
  });

  test("opens Slack from the message body on coarse pointers", () => {
    const originalMatchMedia = window.matchMedia;
    const originalOpen = window.open;
    const openMock = mock(() => null);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: mock((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: mock(() => {}),
        removeListener: mock(() => {}),
        addEventListener: mock(() => {}),
        removeEventListener: mock(() => {}),
        dispatchEvent: mock(() => false),
      })),
    });
    window.open = openMock as unknown as typeof window.open;

    try {
      const { getByTestId } = render(
        <TranscriptMessageBody
          message={{
            id: "slack-1",
            role: "assistant",
            ...textBody("Slack context"),
            slackMessage: {
              channelId: "C123",
              channelTs: "1710000000.000300",
              messageLink: {
                webUrl:
                  "https://example.slack.com/archives/C123/p1710000000000300",
              },
            },
          }}
          expandedToolCallIds={new Set()}
          expandedCardIds={new Map()}
          expandedThinkingKeys={new Map()}
          onSurfaceAction={noop}
        />,
      );

      fireEvent.click(getByTestId("markdown"));

      expect(openMock).toHaveBeenCalledWith(
        "https://example.slack.com/archives/C123/p1710000000000300",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
      window.open = originalOpen;
    }
  });

  test("passes message id to inspect handler", () => {
    const inspectedIds: string[] = [];
    const { getByTitle } = render(
      <TranscriptMessageBody
        message={{
          id: "local-1",
          role: "assistant",
          ...textBody("hello"),
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
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
          ...textBody("hello"),
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        onInspectMessage={(messageId) => inspectedIds.push(messageId)}
      />,
    );

    fireEvent.click(getByTitle("Inspect"));
    expect(inspectedIds).toEqual(["message-1"]);
  });

  test("auto-expands the latest interleaved tool-call group while a tool is running", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          contentOrder: [{ type: "tool", id: "tc-1" }],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "running",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("true");
  });

  test("does not auto-expand a latest interleaved tool-call group whose tools have all completed", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          ...textBody(""),
          contentOrder: [{ type: "tool", id: "tc-1" }],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("false");
  });

  test("auto-expands the last tool-call group of a streaming message even after its tools complete", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          contentOrder: [{ type: "tool", id: "tc-1" }],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        isStreaming
      />,
    );

    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("true");
  });

  test("only the last tool-call group of a streaming message auto-expands", () => {
    const { getAllByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          contentOrder: [
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
            { type: "tool", id: "tc-2" },
          ],
          textSegments: ["Next I will check logs."],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
            {
              id: "tc-2",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        isStreaming
      />,
    );

    expect(
      getAllByTestId("tool-progress-card").map((el) =>
        el.getAttribute("data-auto-expand"),
      ),
    ).toEqual(["false", "true"]);
  });

  test("collapses a streaming message's tool-call group once answer text streams in below it", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          contentOrder: [
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
          ],
          textSegments: ["Here is what I found."],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        isStreaming
      />,
    );

    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("false");
  });

  test("collapses an interleaved tool-call group once response text follows", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          contentOrder: [
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
          ],
          textSegments: ["Done."],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("false");
  });

  test("moves auto-expansion to a later interleaved tool-call group", () => {
    const { getAllByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          contentOrder: [
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
            { type: "tool", id: "tc-2" },
          ],
          textSegments: ["Next I will check logs."],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
            {
              id: "tc-2",
              toolName: "bash",
              input: {},
              status: "running",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      getAllByTestId("tool-progress-card").map((el) =>
        el.getAttribute("data-auto-expand"),
      ),
    ).toEqual(["false", "true"]);
  });

  test("renders user text and an image attachment inside a single bubble", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u1",
          role: "user",
          ...textBody("look at this"),
          attachments: [
            {
              id: "att-1",
              filename: "photo.png",
              mimeType: "image/png",
              sizeBytes: 1234,
              previewUrl: "blob:preview",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const bubbles = container.querySelectorAll(
      "[class*='bg-[var(--surface-lift)]']",
    );
    // Exactly one bubble container carries the surface-lift background.
    expect(bubbles.length).toBe(1);

    const bubble = bubbles[0]!;
    // Text lives inside the bubble.
    expect(bubble.querySelector("[data-testid='markdown']")?.textContent).toBe(
      "look at this",
    );
    // The inline image preview is a descendant of the same bubble, not a sibling.
    const img = bubble.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:preview");

    // The legacy separate strip is not rendered for user messages.
    expect(container.querySelector("[data-testid='attachments']")).toBeNull();
  });

  test("renders an attachment-only user message inside a single bubble", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u2",
          role: "user",
          ...textBody(""),
          attachments: [
            {
              id: "att-1",
              filename: "photo.png",
              mimeType: "image/png",
              sizeBytes: 1234,
              previewUrl: "blob:preview",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const bubbles = container.querySelectorAll(
      "[class*='bg-[var(--surface-lift)]']",
    );
    expect(bubbles.length).toBe(1);
    expect(bubbles[0]!.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview",
    );
    expect(container.querySelector("[data-testid='attachments']")).toBeNull();
  });

  test("renders assistant attachments via the separate MessageAttachments strip", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "a1",
          role: "assistant",
          ...textBody("here you go"),
          attachments: [
            {
              id: "att-1",
              filename: "photo.png",
              mimeType: "image/png",
              sizeBytes: 1234,
              previewUrl: "blob:preview",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    // Assistant path unchanged: separate strip still renders, no surface-lift bubble.
    expect(container.querySelector("[data-testid='attachments']")).not.toBeNull();
    expect(
      container.querySelector("[class*='bg-[var(--surface-lift)]']"),
    ).toBeNull();
  });

  test("renders a user-message surface outside the surface-lift bubble", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u3",
          role: "user",
          contentOrder: [
            { type: "text", id: "0" },
            { type: "surface", id: "s-1" },
          ],
          textSegments: ["do this"],
          surfaces: [{ surfaceId: "s-1" } as never],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const bubble = container.querySelector(
      "[class*='bg-[var(--surface-lift)]']",
    );
    expect(bubble).not.toBeNull();
    // Text lives inside the bubble.
    expect(bubble!.querySelector("[data-testid='markdown']")?.textContent).toBe(
      "do this",
    );
    // The surface renders, but OUTSIDE the bubble (not a descendant).
    const surface = container.querySelector("[data-testid='surface']");
    expect(surface).not.toBeNull();
    expect(bubble!.contains(surface)).toBe(false);
  });

  test("preserves contentOrder for a [surface, text] user message (surface before text, outside the bubble)", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u-order-1",
          role: "user",
          contentOrder: [
            { type: "surface", id: "s-1" },
            { type: "text", id: "0" },
          ],
          textSegments: ["after surface"],
          surfaces: [{ surfaceId: "s-1" } as never],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const surface = container.querySelector("[data-testid='surface']");
    const markdown = container.querySelector("[data-testid='markdown']");
    expect(surface).not.toBeNull();
    expect(markdown?.textContent).toBe("after surface");

    // DOM order matches contentOrder: surface appears before the text.
    expect(
      surface!.compareDocumentPosition(markdown!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The surface is NOT inside a surface-lift bubble; the text IS.
    const bubble = container.querySelector(
      "[class*='bg-[var(--surface-lift)]']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.contains(surface)).toBe(false);
    expect(bubble!.contains(markdown)).toBe(true);
  });

  test("preserves contentOrder for an interleaved [text, tool, text] user message (tool between text, outside bubbles)", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u-order-2",
          role: "user",
          contentOrder: [
            { type: "text", id: "0" },
            { type: "tool", id: "tc-1" },
            { type: "text", id: "1" },
          ],
          textSegments: [
            "before tool",
            "after tool",
          ],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const markdowns = container.querySelectorAll("[data-testid='markdown']");
    const toolCard = container.querySelector(
      "[data-testid='tool-progress-card']",
    );
    expect(markdowns.length).toBe(2);
    expect(markdowns[0]!.textContent).toBe("before tool");
    expect(markdowns[1]!.textContent).toBe("after tool");
    expect(toolCard).not.toBeNull();

    // DOM order matches contentOrder: text → tool → text.
    expect(
      markdowns[0]!.compareDocumentPosition(toolCard!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      toolCard!.compareDocumentPosition(markdowns[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Two separate surface-lift bubbles wrap the two text runs; the tool card
    // is outside both.
    const bubbles = container.querySelectorAll(
      "[class*='bg-[var(--surface-lift)]']",
    );
    expect(bubbles.length).toBe(2);
    for (const bubble of bubbles) {
      expect(bubble.contains(toolCard)).toBe(false);
    }
  });

  test("omits the user bubble when an interleaved user message has no text or attachments", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u4",
          role: "user",
          ...textBody(""),
          contentOrder: [{ type: "tool", id: "tc-1" }],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    // No visible text and no attachments: the empty surface-lift bubble must
    // not render.
    expect(
      container.querySelector("[class*='bg-[var(--surface-lift)]']"),
    ).toBeNull();
    // Non-text elements (the tool-call card) still render.
    expect(
      container.querySelector("[data-testid='tool-progress-card']"),
    ).not.toBeNull();
  });

  test("auto-expands legacy tool-only messages while a tool runs, until content appears", () => {
    const { getByTestId, rerender } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          ...textBody(""),
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "running",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );
    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("true");

    rerender(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          ...textBody("Done."),
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );
    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("false");
  });

  test("renders a 'Thought process' block for completed reasoning followed by text", () => {
    // GIVEN a persisted assistant message whose reasoning precedes its answer
    // WHEN it is rendered (legacy path — no interleaved tool calls)
    const html = renderMessage({
      id: "m-think",
      role: "assistant",
      textSegments: ["the answer"],
      thinkingSegments: ["chain of thought"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "text", id: "0" },
      ],
      timestamp: 1_000,
    });

    // THEN the reasoning renders as a completed, collapsed thinking block
    expect(html).toContain("Thought process");
    expect(html).not.toContain("Thinking…");
  });

  test("labels trailing reasoning as 'Thinking…' while the row is live", () => {
    // GIVEN an assistant row mid-reasoning: a thinking block is the last
    // content entry with no text or tool output after it yet
    // WHEN it is rendered as the in-flight turn (isStreaming)
    const html = renderMessage(
      {
        id: "m-think-live",
        role: "assistant",
        textSegments: [],
        thinkingSegments: ["reasoning in progress"],
        contentOrder: [{ type: "thinking", id: "0" }],
        timestamp: 1_000,
      },
      { isStreaming: true },
    );

    // THEN the block reads as still-streaming
    expect(html).toContain("Thinking…");
    expect(html).not.toContain("Thought process");
  });

  test("labels trailing reasoning of a completed turn as 'Thought process'", () => {
    // GIVEN a persisted/completed assistant turn that ends in reasoning with
    // nothing after it (e.g. a reasoning-only or truncated turn restored from
    // history, or after message_complete / cancellation)
    // WHEN it is rendered as a settled row (not streaming)
    const html = renderMessage({
      id: "m-think-done",
      role: "assistant",
      textSegments: [],
      thinkingSegments: ["reasoning that finished"],
      contentOrder: [{ type: "thinking", id: "0" }],
      timestamp: 1_000,
    });

    // THEN the trailing block reads as finished, not perpetually streaming
    expect(html).toContain("Thought process");
    expect(html).not.toContain("Thinking…");
  });

  test("renders a thinking block interleaved with tool calls", () => {
    // GIVEN an assistant message that reasons, calls a tool, then answers
    // WHEN it is rendered (interleaved path — contentOrder carries a tool)
    const html = renderMessage({
      id: "m-think-interleaved",
      role: "assistant",
      textSegments: ["done"],
      thinkingSegments: ["why I called the tool"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "0" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-1", toolName: "bash", input: {}, status: "completed" },
      ],
      timestamp: 1_000,
    });

    // THEN both the thinking block and the tool-call card render
    expect(html).toContain("Thought process");
    expect(html).toContain('data-testid="tool-progress-card"');
  });

  function renderedAnchorIds(container: HTMLElement): string[] {
    return Array.from(
      container.querySelectorAll("[data-activity-anchor]"),
    ).map((el) => el.getAttribute("data-activity-anchor")!);
  }

  function projectedAnchorIds(message: DisplayMessage): string[] {
    return buildTurnActivity(message).steps.map((s) => s.anchorId);
  }

  test("interleaved render anchors exactly match buildTurnActivity step anchors", () => {
    const message: DisplayMessage = {
      id: "m-anchor-interleaved",
      role: "assistant",
      textSegments: ["done"],
      thinkingSegments: ["why I called the tool", "more reasoning"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "0" },
        { type: "thinking", id: "1" },
        { type: "toolCall", id: "1" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-a", toolName: "bash", input: {}, status: "completed" },
        { id: "tc-b", toolName: "bash", input: {}, status: "completed" },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const projected = projectedAnchorIds(message);
    expect(projected.length).toBe(4);
    // Interleaved DOM order matches projection order exactly.
    expect(renderedAnchorIds(container)).toEqual(projected);
  });

  test("legacy render anchors exactly match buildTurnActivity step anchors", () => {
    const message: DisplayMessage = {
      id: "m-anchor-legacy",
      role: "assistant",
      textSegments: ["the answer"],
      thinkingSegments: ["chain of thought"],
      contentOrder: [{ type: "thinking", id: "0" }],
      toolCalls: [
        { id: "tc-legacy", toolName: "bash", input: {}, status: "completed" },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const projected = projectedAnchorIds(message);
    expect(projected.length).toBe(2);
    // The legacy DOM renders the trailing tool card above the reasoning block,
    // while the projection lists thinking first then the trailing tool step —
    // so the anchor *ids* are byte-identical but emitted in a different order.
    // Compare as sets to assert the critical render-id === projection-id match.
    expect(new Set(renderedAnchorIds(container))).toEqual(new Set(projected));
  });

  test("legacy [spawn, bash] anchors the tool card on the bash call, matching buildTurnActivity", () => {
    // GIVEN a legacy turn whose FIRST tool call is a subagent spawn followed by
    // a renderable bash call — `buildTurnActivity` anchors the legacy tool step
    // on the first NON-spawn (renderable) call, so the rendered DOM anchor must
    // resolve to the bash id, not the leading spawn id.
    const message: DisplayMessage = {
      id: "m-anchor-legacy-spawn",
      role: "assistant",
      textSegments: ["the answer"],
      thinkingSegments: ["chain of thought"],
      contentOrder: [{ type: "thinking", id: "0" }],
      toolCalls: [
        {
          id: "tc-spawn",
          toolName: "subagent_spawn",
          input: {},
          status: "completed",
        },
        { id: "tc-bash", toolName: "bash", input: {}, status: "completed" },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    const projected = projectedAnchorIds(message);
    // Two projected steps: the thinking block and the trailing tool step.
    expect(projected.length).toBe(2);
    // The trailing tool step anchors on the bash call's id (the first
    // renderable, non-spawn call) — NOT the leading spawn.
    const toolAnchor = projected.find((id) => id.includes("-tc-"));
    expect(toolAnchor).toBe("activity-m-anchor-legacy-spawn-tc-tc-bash");

    // Render anchors are byte-identical to the projection (legacy emits the
    // trailing tool card above the reasoning block, so order differs; compare
    // as a set to assert id equality).
    expect(new Set(renderedAnchorIds(container))).toEqual(new Set(projected));
  });

  test("a subagent-spawn-only group produces no activity anchor", () => {
    const message: DisplayMessage = {
      id: "m-spawn-only",
      role: "assistant",
      textSegments: ["spawning"],
      contentOrder: [
        { type: "toolCall", id: "0" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        {
          id: "tc-spawn",
          toolName: "subagent_spawn",
          input: {},
          status: "completed",
        },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(projectedAnchorIds(message)).toEqual([]);
    expect(renderedAnchorIds(container)).toEqual([]);
  });

  test("legacy spawn-only turn renders no tool activity anchor (no empty wrapper)", () => {
    // GIVEN a legacy turn (no tool entries in contentOrder) whose toolCalls are
    // ALL subagent spawns. The tool card filters the spawns out and renders
    // nothing, so the anchored flex wrapper must NOT render — otherwise it
    // leaves a stray empty `gap-2` gap before the inline subagent cards/text.
    const message: DisplayMessage = {
      id: "m-legacy-spawn-only",
      role: "assistant",
      textSegments: ["the answer"],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        {
          id: "tc-spawn-1",
          toolName: "subagent_spawn",
          input: {},
          status: "completed",
        },
        {
          id: "tc-spawn-2",
          toolName: "subagent_spawn",
          input: {},
          status: "completed",
        },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    // No tool step is projected, and no anchored tool wrapper is rendered.
    expect(projectedAnchorIds(message)).toEqual([]);
    expect(renderedAnchorIds(container)).toEqual([]);
  });

  test("a suppressed ui_show group produces no activity anchor", () => {
    const message: DisplayMessage = {
      id: "m-ui-show",
      role: "assistant",
      textSegments: ["showing UI"],
      contentOrder: [
        { type: "toolCall", id: "0" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-ui", toolName: "ui_show", input: {}, status: "completed" },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(projectedAnchorIds(message)).toEqual([]);
    expect(renderedAnchorIds(container)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Combined activity-summary card (web-activity-summary flag)
  // ---------------------------------------------------------------------------

  /** A task-progress surface fixture, as produced by a `task_progress` card. */
  function taskProgressSurface(surfaceId: string): Surface {
    return {
      surfaceId,
      surfaceType: "card",
      data: {
        template: "task_progress",
        templateData: {
          steps: [{ id: "s1", label: "Do the thing", status: "completed" }],
        },
      },
    };
  }

  /** Assistant message with thinking + a tool call + a task-progress surface. */
  function activityMessage(surfaceId = "tps-1"): DisplayMessage {
    return {
      id: "m-activity",
      role: "assistant",
      textSegments: ["all done"],
      thinkingSegments: ["reasoning"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "0" },
        { type: "surface", id: surfaceId },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-1", toolName: "bash", input: {}, status: "completed" },
      ],
      surfaces: [taskProgressSurface(surfaceId)],
      timestamp: 1_000,
    };
  }

  test("flag ON: renders one combined card at the top with the task-progress surface hoisted, not inline", () => {
    const message = activityMessage();
    const { container, getByTestId } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        activitySummaryEnabled
      />,
    );

    // Exactly one combined-card header block renders, and it is the first child
    // of the assistant content column (above the inline tool card).
    const header = getByTestId("turn-activity-header");
    expect(header).not.toBeNull();
    expect(
      container.querySelectorAll("[data-testid='turn-activity-header']").length,
    ).toBe(1);

    const toolCard = container.querySelector(
      "[data-testid='tool-progress-card']",
    );
    expect(toolCard).not.toBeNull();
    expect(
      header.compareDocumentPosition(toolCard!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The task-progress surface renders exactly once, and it lives INSIDE the
    // header block (hoisted) — not in its inline position.
    const surfaces = container.querySelectorAll(
      "[data-testid='surface'][data-surface-id='tps-1']",
    );
    expect(surfaces.length).toBe(1);
    expect(header.contains(surfaces[0]!)).toBe(true);

    // Inline tool/thinking cards still render with their activity anchors.
    expect(renderedAnchorIds(container)).toEqual(projectedAnchorIds(message));
  });

  test("flag ON: clicking a pill calls onActivityStepClick with a matching inline anchorId", () => {
    const message = activityMessage();
    const clicked: string[] = [];
    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        activitySummaryEnabled
        onActivityStepClick={(id) => clicked.push(id)}
      />,
    );

    // The combined card starts collapsed; expand it so the step pills mount.
    const expandToggle = container.querySelector(
      "[aria-label='Expand steps']",
    );
    expect(expandToggle).not.toBeNull();
    fireEvent.click(expandToggle!);

    const pill = container.querySelector("[data-testid='turn-progress-pill']");
    expect(pill).not.toBeNull();
    // The pill wraps the actual clickable; click the inner button/element.
    fireEvent.click(pill!.querySelector("button") ?? pill!);

    expect(clicked.length).toBe(1);
    // The clicked anchor matches one of the message's inline anchors.
    expect(renderedAnchorIds(container)).toContain(clicked[0]!);
  });

  test("flag OFF (default): no combined card; task-progress surface renders inline", () => {
    const message = activityMessage();
    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      container.querySelector("[data-testid='turn-activity-header']"),
    ).toBeNull();
    // The task-progress surface renders once, in its original inline position.
    const surfaces = container.querySelectorAll(
      "[data-testid='surface'][data-surface-id='tps-1']",
    );
    expect(surfaces.length).toBe(1);
  });

  test("flag ON but no tool/thinking activity: no combined card; surface renders inline", () => {
    const message: DisplayMessage = {
      id: "m-no-activity",
      role: "assistant",
      textSegments: ["here is a plan"],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "surface", id: "tps-2" },
      ],
      surfaces: [taskProgressSurface("tps-2")],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        expandedThinkingKeys={new Map()}
        onSurfaceAction={noop}
        activitySummaryEnabled
      />,
    );

    // No steps → no combined card, and the surface is NOT hoisted.
    expect(
      container.querySelector("[data-testid='turn-activity-header']"),
    ).toBeNull();
    const surfaces = container.querySelectorAll(
      "[data-testid='surface'][data-surface-id='tps-2']",
    );
    expect(surfaces.length).toBe(1);
  });
});
