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

  test("renders an explicit Open in Slack hover action for Slack messages", () => {
    const { getByRole } = render(
      <TranscriptMessageBody
        message={{
          id: "slack-1",
          role: "assistant",
          content: "Slack context",
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
            content: "Slack context",
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

  test("auto-expands the latest interleaved tool-call group while the row is streaming", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          content: "",
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
        isStreaming
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
      />,
    );

    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("true");
  });

  test("collapses an interleaved tool-call group once response text follows", () => {
    const { getByTestId } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          content: "",
          contentOrder: [
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
          ],
          textSegments: [{ type: "text", content: "Done." }],
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        isStreaming
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
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
          content: "",
          contentOrder: [
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
            { type: "tool", id: "tc-2" },
          ],
          textSegments: [{ type: "text", content: "Next I will check logs." }],
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
        isStreaming
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
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
          content: "look at this",
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
          content: "",
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
          content: "here you go",
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
          content: "",
          contentOrder: [
            { type: "text", id: "0" },
            { type: "surface", id: "s-1" },
          ],
          textSegments: [{ type: "text", content: "do this" }],
          surfaces: [{ surfaceId: "s-1" } as never],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
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
          content: "",
          contentOrder: [
            { type: "surface", id: "s-1" },
            { type: "text", id: "0" },
          ],
          textSegments: [{ type: "text", content: "after surface" }],
          surfaces: [{ surfaceId: "s-1" } as never],
        }}
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
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
          content: "",
          contentOrder: [
            { type: "text", id: "0" },
            { type: "tool", id: "tc-1" },
            { type: "text", id: "1" },
          ],
          textSegments: [
            { type: "text", content: "before tool" },
            { type: "text", content: "after tool" },
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
          content: "",
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

  test("auto-expands legacy tool-only streaming messages until content appears", () => {
    const { getByTestId, rerender } = render(
      <TranscriptMessageBody
        message={{
          id: "m1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        isStreaming
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
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
          content: "Done.",
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }}
        isStreaming
        expandedToolCallIds={new Set()}
        expandedCardIds={new Map()}
        onSurfaceAction={noop}
      />,
    );
    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("false");
  });
});
