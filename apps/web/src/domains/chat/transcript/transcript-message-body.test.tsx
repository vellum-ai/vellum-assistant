import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";

// The legacy reasoning path now renders the real `ThoughtProcessLink`, which
// pulls in the viewer store → the generated daemon SDK (not built in CI/worktree
// checkouts). Stub the two endpoints it references so the module loads; the
// component never invokes them. Mirrors the mock in `thought-process-link.test.tsx`.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => ({ data: undefined }),
  documentsByIdGet: async () => ({ data: undefined }),
}));

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
  "@/domains/chat/components/activity-run-card/activity-run-card",
  () => ({
    ActivityRunCard: ({
      autoExpand,
      toolCalls,
      items,
    }: {
      autoExpand?: boolean;
      toolCalls: Array<{ id: string }>;
      items?: Array<
        | { kind: "thinking"; text: string }
        | { kind: "toolCall"; toolCall: { id: string } }
      >;
    }) => (
      <div
        data-testid="tool-progress-card"
        data-auto-expand={autoExpand ? "true" : "false"}
        data-tool-call-ids={toolCalls.map((tc) => tc.id).join(",")}
        // Surface the ordered items so the merged-card tests can assert the
        // interleaved thinking + tool steps the card would render in its body.
        data-item-kinds={items?.map((i) => i.kind).join(",") ?? ""}
        data-item-thinking={
          items
            ?.filter(
              (i): i is { kind: "thinking"; text: string } =>
                i.kind === "thinking",
            )
            .map((i) => i.text)
            .join("|") ?? ""
        }
        data-item-tool-ids={
          items
            ?.filter(
              (i): i is { kind: "toolCall"; toolCall: { id: string } } =>
                i.kind === "toolCall",
            )
            .map((i) => i.toolCall.id)
            .join(",") ?? ""
        }
      />
    ),
  }),
);

mock.module(
  "@/domains/chat/components/inline-activity-link/inline-tool-link",
  () => ({
    InlineToolLink: ({ toolCall }: { toolCall: { id: string } }) => (
      <div data-testid="inline-tool-link" data-tool-call-id={toolCall.id} />
    ),
  }),
);

import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";

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
          name: "bash",
          input: {},
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
          name: "bash",
          input: {},
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
          thinkingSegments: ["reasoning"],
          contentOrder: [
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
          ],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
            },
          ],
        }}
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
          thinkingSegments: ["reasoning"],
          contentOrder: [
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
          ],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
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
          thinkingSegments: ["reasoning"],
          contentOrder: [
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
          ],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
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
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
            { type: "thinking", id: "1" },
            { type: "tool", id: "tc-2" },
          ],
          textSegments: ["Next I will check logs."],
          thinkingSegments: ["reason A", "reason B"],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
            {
              id: "tc-2",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
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
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
          ],
          textSegments: ["Here is what I found."],
          thinkingSegments: ["reasoning"],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
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
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
          ],
          textSegments: ["Done."],
          thinkingSegments: ["reasoning"],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
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
            { type: "thinking", id: "0" },
            { type: "tool", id: "tc-1" },
            { type: "text", id: "0" },
            { type: "thinking", id: "1" },
            { type: "tool", id: "tc-2" },
          ],
          textSegments: ["Next I will check logs."],
          thinkingSegments: ["reason A", "reason B"],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
            {
              id: "tc-2",
              name: "bash",
              input: {},
            },
          ],
        }}
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
            { type: "toolCall", id: "tc-1" },
            { type: "text", id: "1" },
          ],
          textSegments: [
            "before tool",
            "after tool",
          ],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
        onSurfaceAction={noop}
      />,
    );

    const markdowns = container.querySelectorAll("[data-testid='markdown']");
    // A lone non-web tool renders as the compact inline chip in the redesign,
    // not a boxed card.
    const toolChip = container.querySelector(
      "[data-testid='inline-tool-link']",
    );
    expect(markdowns.length).toBe(2);
    expect(markdowns[0]!.textContent).toBe("before tool");
    expect(markdowns[1]!.textContent).toBe("after tool");
    expect(toolChip).not.toBeNull();

    // DOM order matches contentOrder: text → tool → text.
    expect(
      markdowns[0]!.compareDocumentPosition(toolChip!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      toolChip!.compareDocumentPosition(markdowns[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The tool chip is never wrapped inside a surface-lift text bubble — in the
    // interleaved branch the text runs render inline and the chip sits between
    // them rather than inside any bubble.
    const bubbles = container.querySelectorAll(
      "[class*='bg-[var(--surface-lift)]']",
    );
    for (const bubble of bubbles) {
      expect(bubble.contains(toolChip)).toBe(false);
    }
  });

  test("omits the user bubble when an interleaved user message has no text or attachments", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u4",
          role: "user",
          ...textBody(""),
          contentOrder: [{ type: "toolCall", id: "tc-1" }],
          toolCalls: [
            {
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
        onSurfaceAction={noop}
      />,
    );

    // No visible text and no attachments: the empty surface-lift bubble must
    // not render.
    expect(
      container.querySelector("[class*='bg-[var(--surface-lift)]']"),
    ).toBeNull();
    // The lone tool still renders as the inline chip.
    expect(
      container.querySelector("[data-testid='inline-tool-link']"),
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
              name: "bash",
              input: {},
            },
          ],
        }}
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
              name: "bash",
              input: {},
              completedAt: 1,
            },
          ],
        }}
        onSurfaceAction={noop}
      />,
    );
    expect(
      getByTestId("tool-progress-card").getAttribute("data-auto-expand"),
    ).toBe("false");
  });

  test("renders a 'Thought process' link for completed reasoning followed by text", () => {
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

    // THEN the reasoning renders as a completed ThoughtProcessLink
    expect(html).toContain("Thought process");
    expect(html).not.toContain("Thinking");
  });

  test("labels trailing reasoning as 'Thinking' while the row is live", () => {
    // GIVEN an assistant row mid-reasoning: a thinking run is the last
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

    // THEN the link reads as still-streaming ("Thinking" + the dot loader),
    // not the settled "Thought process".
    expect(html).toContain("Thinking");
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

    // THEN the trailing link reads as finished, not perpetually streaming
    expect(html).toContain("Thought process");
    expect(html).not.toContain("Thinking");
  });

  test("merges interleaved thinking + tool into one activity card", () => {
    // GIVEN an assistant message that reasons, calls a tool, then answers
    // WHEN it is rendered (interleaved path — contentOrder carries a tool)
    const { container } = render(
      <TranscriptMessageBody
        message={{
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
            { id: "tc-1", name: "bash", input: {}, completedAt: 1 },
          ],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    // THEN the thinking + tool merge into a single boxed activity card whose
    // ordered body carries both the reasoning and the tool step.
    const card = container.querySelector("[data-testid='tool-progress-card']");
    expect(card).not.toBeNull();
    expect(card!.getAttribute("data-item-kinds")).toBe("thinking,toolCall");
    expect(card!.getAttribute("data-item-thinking")).toBe(
      "why I called the tool",
    );
  });


  // ---------------------------------------------------------------------------
  // Merged activity-run rendering (always-on)
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

  test("merges contiguous thinking + tool runs into one card per run", () => {
    // contentOrder [thinking, tool, thinking, text, tool, thinking] →
    // two activity runs (before/after the text), each one merged card, plus
    // the text between them.
    const message: DisplayMessage = {
      id: "m-merged",
      role: "assistant",
      textSegments: ["the middle answer"],
      thinkingSegments: ["reason A", "reason B", "reason C"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "0" },
        { type: "thinking", id: "1" },
        { type: "text", id: "0" },
        { type: "toolCall", id: "1" },
        { type: "thinking", id: "2" },
      ],
      toolCalls: [
        { id: "tc-a", name: "bash", input: {}, completedAt: 1 },
        { id: "tc-b", name: "bash", input: {}, completedAt: 1 },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        onSurfaceAction={noop}
      />,
    );

    // Exactly two merged tool cards (one per run).
    const cards = container.querySelectorAll(
      "[data-testid='tool-progress-card']",
    );
    expect(cards.length).toBe(2);

    // The first card's ordered body is thinking → tool → thinking, carrying
    // both reasoning texts and the tool step.
    const first = cards[0]!;
    expect(first.getAttribute("data-item-kinds")).toBe(
      "thinking,toolCall,thinking",
    );
    expect(first.getAttribute("data-item-thinking")).toBe("reason A|reason B");
    expect(first.getAttribute("data-item-tool-ids")).toBe("tc-a");

    // The second card carries the trailing tool + thinking run.
    const second = cards[1]!;
    expect(second.getAttribute("data-item-kinds")).toBe("toolCall,thinking");
    expect(second.getAttribute("data-item-tool-ids")).toBe("tc-b");

    // The text between the two runs renders.
    const markdowns = container.querySelectorAll("[data-testid='markdown']");
    expect(
      Array.from(markdowns).some((m) => m.textContent === "the middle answer"),
    ).toBe(true);

    // No legacy summary card and no scroll anchors remain.
    expect(
      container.querySelector("[data-testid='turn-activity-header']"),
    ).toBeNull();
    expect(container.querySelector("[data-activity-anchor]")).toBeNull();
  });

  test("a pure-thinking run renders an inline ThoughtProcessLink, not a tool card", () => {
    // contentOrder carries a tool elsewhere so the interleaved branch is taken,
    // but the FIRST run before the text is pure thinking.
    const message: DisplayMessage = {
      id: "m-pure-thinking",
      role: "assistant",
      textSegments: ["answer"],
      thinkingSegments: ["just reasoning"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "text", id: "0" },
        { type: "toolCall", id: "0" },
      ],
      toolCalls: [
        { id: "tc-a", name: "bash", input: {}, completedAt: 1 },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        onSurfaceAction={noop}
      />,
    );

    // The pure-thinking run renders as the inline `ThoughtProcessLink`
    // ("Thought process"). The trailing lone bash tool run renders as the
    // compact inline chip, NOT a boxed tool card.
    expect(
      container.querySelector("[data-testid='thought-process-link']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Thought process");
    expect(
      container.querySelectorAll("[data-testid='tool-progress-card']").length,
    ).toBe(0);
    expect(
      container.querySelectorAll("[data-testid='inline-tool-link']").length,
    ).toBe(1);
  });

  test("a task-progress surface renders inline (not hoisted, not suppressed)", () => {
    const message: DisplayMessage = {
      id: "m-activity-inline",
      role: "assistant",
      textSegments: ["all done"],
      thinkingSegments: ["reasoning"],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "0" },
        { type: "surface", id: "tps-1" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-1", name: "bash", input: {}, completedAt: 1 },
      ],
      surfaces: [taskProgressSurface("tps-1")],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        onSurfaceAction={noop}
      />,
    );

    // No summary card.
    expect(
      container.querySelector("[data-testid='turn-activity-header']"),
    ).toBeNull();
    // The task-progress surface renders exactly once, in its inline position
    // AFTER the merged activity card.
    const surfaces = container.querySelectorAll(
      "[data-testid='surface'][data-surface-id='tps-1']",
    );
    expect(surfaces.length).toBe(1);
    const card = container.querySelector("[data-testid='tool-progress-card']");
    expect(card).not.toBeNull();
    expect(
      card!.compareDocumentPosition(surfaces[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("a lone single bash tool run renders the inline chip, not a card", () => {
    const message: DisplayMessage = {
      id: "m-lone-tool",
      role: "assistant",
      textSegments: ["done"],
      contentOrder: [
        { type: "toolCall", id: "0" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-lone", name: "bash", input: {}, completedAt: 1 },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        onSurfaceAction={noop}
      />,
    );

    const chip = container.querySelector("[data-testid='inline-tool-link']");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-tool-call-id")).toBe("tc-lone");
    expect(
      container.querySelector("[data-testid='tool-progress-card']"),
    ).toBeNull();
  });

  test("a tool + thinking run still renders the boxed activity card", () => {
    const message: DisplayMessage = {
      id: "m-tool-thinking",
      role: "assistant",
      textSegments: ["done"],
      thinkingSegments: ["reasoning about the tool"],
      contentOrder: [
        { type: "toolCall", id: "0" },
        { type: "thinking", id: "0" },
        { type: "text", id: "0" },
      ],
      toolCalls: [
        { id: "tc-mix", name: "bash", input: {}, completedAt: 1 },
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody
        message={message}
        onSurfaceAction={noop}
      />,
    );

    // A run with more than one card item (tool + thinking) is NOT a lone tool,
    // so it stays the boxed card.
    expect(
      container.querySelector("[data-testid='tool-progress-card']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='inline-tool-link']"),
    ).toBeNull();
  });
});
