import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// The transcript transitively pulls in the viewer store → the generated daemon
// SDK (not built in CI/worktree checkouts). Stub the two endpoints it references
// so the module loads; nothing here invokes them. Mirrors the mock in
// `single-activity.test.tsx`.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => ({ data: undefined }),
  documentsByIdGet: async () => ({ data: undefined }),
}));

mock.module(
  "@/domains/chat/components/chat-attachments/message-attachments",
  () => ({
    MessageAttachments: () => <div data-testid="attachments" />,
  }),
);

// The ACP-run and background-task rows wire their transcript stop button to
// these standalone actions; stub them so clicking Stop records the call without
// pulling in the daemon SDK / store wiring.
const stopAcpRunMock = mock(async () => {});
const stopBackgroundTaskMock = mock(async () => {});
mock.module("@/domains/chat/utils/acp-run-actions", () => ({
  stopAcpRun: stopAcpRunMock,
}));
mock.module("@/domains/chat/utils/background-task-actions", () => ({
  stopBackgroundTask: stopBackgroundTaskMock,
}));

// Captures the latest `onVellumLinkClick` handler so tests can drive the
// vellum:// link download path directly through the mocked markdown renderer.
let lastVellumLinkClick: ((href: string, linkText: string) => void) | undefined;
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({
    content,
    hardLineBreaks,
    onVellumLinkClick,
  }: {
    content: string;
    hardLineBreaks?: boolean;
    onVellumLinkClick?: (href: string, linkText: string) => void;
  }) => {
    lastVellumLinkClick = onVellumLinkClick;
    return (
      <div
        data-testid="markdown"
        data-hard-line-breaks={hardLineBreaks ? "true" : "false"}
      >
        {content}
      </div>
    );
  },
}));

// `handleVellumLinkClick` resolves the clicked link to an attachment and hands
// it to `downloadAttachment`; stub it to record which attachment matched.
// The stub mirrors the real helper's `previewUrl` fallback branch (the only
// one reachable without an assistantId) so the mid-turn tool-result image
// test still observes `saveFile` receiving the data-URL bytes.
const downloadAttachmentMock = mock(
  async (attachment: { filename: string; previewUrl: string | null }) => {
    if (attachment.previewUrl) {
      const { saveFile } = await import("@/runtime/native-file");
      await saveFile(attachment.previewUrl, attachment.filename);
    }
  },
);
mock.module(
  "@/domains/chat/components/chat-attachments/download-attachment",
  () => ({
    downloadAttachment: downloadAttachmentMock,
  }),
);

mock.module("@/domains/chat/components/surfaces/surface-router", () => ({
  SurfaceRouter: ({ surface }: { surface: { surfaceId: string } }) => (
    <div data-testid="surface" data-surface-id={surface.surfaceId} />
  ),
}));

mock.module(
  "@/domains/chat/components/multi-activity-group/multi-activity-group",
  () => ({
    MultiActivityGroup: ({
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

// `SingleActivity` is the lone inline link for both a single tool call
// (`variant="tool"`) and an assistant reasoning run (`variant="thinking"`).
// Stub the tool variant to a lightweight chip carrying its id; render the
// thinking variant faithfully enough for the label / no-op assertions (the
// real component is exercised in `single-activity.test.tsx`).
mock.module(
  "@/domains/chat/components/single-activity/single-activity",
  () => ({
    SingleActivity: (
      props:
        | { variant: "thinking"; content: string; isStreaming?: boolean }
        | { variant: "tool"; toolCall: { id: string } },
    ) => {
      if (props.variant === "tool") {
        return (
          <div
            data-testid="inline-tool-link"
            data-tool-call-id={props.toolCall.id}
          />
        );
      }
      const { content, isStreaming = false } = props;
      // No-ops once settled with empty content (mirrors the real link).
      if (!content && !isStreaming) {
        return null;
      }
      return (
        <div data-testid="thought-process-link">
          {isStreaming ? "Thinking" : "Thought process"}
        </div>
      );
    },
  }),
);

// The four transcript inline-card render paths (workflow / ACP run /
// background task — and subagent, via `SubagentSpawnGroup`) all route through
// the generic `InlineProcessCardRow`. Stub it so these tests can assert which
// descriptor + id each render helper maps to, and that the transcript's
// `onOpen`/`onStop` wiring reaches the row — without hydrating each kind's
// store (the row's own markup is covered by `inline-process-card.test`).
mock.module("@/domains/chat/process-registry/inline-process-card-row", () => ({
  InlineProcessCardRow: ({
    descriptor,
    id,
    onOpen,
    onStop,
  }: {
    descriptor: { kind: string };
    id: string;
    onOpen?: () => void;
    onStop?: () => void;
  }) => (
    <div
      data-testid="inline-process-card"
      data-process-kind={descriptor.kind}
      data-process-id={id}
      data-has-stop={onStop ? "true" : "false"}
    >
      <button
        type="button"
        data-testid="inline-process-card-open"
        onClick={() => onOpen?.()}
      />
      <button
        type="button"
        data-testid="inline-process-card-stop"
        onClick={() => onStop?.()}
      />
    </div>
  ),
}));

// The mid-turn tool-result image strip downloads data-URL bytes through
// `downloadAttachment`, which lazily imports the native-file bridge. Stub it so
// clicking Download records the call without touching Capacitor / DOM anchors.
const saveFileMock = mock(async () => {});
mock.module("@/runtime/native-file", () => ({
  saveFile: saveFileMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";

const noop = () => {};

// `TranscriptMessageBody` renders a row's body by walking its unified
// `contentBlocks` projection — the sole source of truth. Each block embeds its
// own referent (text, reasoning, tool call, surface ref), so these fixtures
// carry only `contentBlocks` plus the referent arrays the blocks point into
// (`toolCalls`/`surfaces`/`attachments`); the legacy positional arrays
// (`contentOrder`/`textSegments`/`thinkingSegments`) play no part in rendering.

/** A single text block. */
function textBlock(text: string): ConversationContentBlock {
  return { type: "text", text };
}

/** A reasoning block carrying its text and optional run timing. */
function thinkingBlock(
  thinking: string,
  timing: { startedAt?: number; completedAt?: number } = {},
): ConversationContentBlock {
  return { type: "thinking", thinking, ...timing };
}

/** A tool-use block embedding its client tool call. */
function toolUseBlock(toolCall: ChatMessageToolCall): ConversationContentBlock {
  return { type: "tool_use", toolCall };
}

/**
 * A surface block embedding its surface. The block stream drives ordering and
 * presence, and the render reads the surface straight off the block.
 */
function surfaceBlock(surfaceId: string): ConversationContentBlock {
  return { type: "surface", surface: { surfaceId } as never };
}

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
  test("renders assistant text straight from a text block with hard line breaks", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-text",
          role: "assistant",
          contentBlocks: [textBlock("line one\nline two")],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const markdown = container.querySelector("[data-testid='markdown']");
    expect(markdown).not.toBeNull();
    expect(markdown!.textContent).toBe("line one\nline two");
    // Hard line breaks stay enabled for assistant prose (JARVIS-1007).
    expect(markdown!.getAttribute("data-hard-line-breaks")).toBe("true");
  });

  test("renders user text from a text block inside the user bubble with hard line breaks", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-user-text",
          role: "user",
          contentBlocks: [textBlock("line one\nline two")],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const markdown = container.querySelector("[data-testid='markdown']");
    expect(markdown).not.toBeNull();
    expect(markdown!.textContent).toBe("line one\nline two");
    expect(markdown!.getAttribute("data-hard-line-breaks")).toBe("true");
    // The text run is wrapped in the surface-lift user bubble.
    expect(
      container.querySelector(".bg-\\[var\\(--surface-lift\\)\\]"),
    ).not.toBeNull();
  });

  test("uses the latest tool completion as the message activity timestamp", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-1",
      name: "bash",
      input: {},
      startedAt: 1_500,
      completedAt: 2_000,
    };
    const html = renderMessage({
      id: "m1",
      role: "assistant",
      contentBlocks: [toolUseBlock(toolCall)],
      toolCalls: [toolCall],
      timestamp: 1_000,
    });

    expect(html).toContain("title=");
    expect(html).toContain(":02");
  });

  test("falls back to the tool start time for active tool-only messages", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-1",
      name: "bash",
      input: {},
      startedAt: 1_500,
    };
    const html = renderMessage({
      id: "m1",
      role: "assistant",
      contentBlocks: [toolUseBlock(toolCall)],
      toolCalls: [toolCall],
      timestamp: 1_000,
    });

    expect(html).toContain("title=");
    expect(html).toContain(":01");
  });

  test("uses the assistant identity name for Slack assistant attribution fallback", () => {
    const html = renderMessage(
      {
        id: "m1",
        role: "assistant",
        contentBlocks: [textBlock("hello from Slack")],
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
          contentBlocks: [textBlock("Slack context")],
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
            contentBlocks: [textBlock("Slack context")],
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
          contentBlocks: [textBlock("hello")],
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
          contentBlocks: [textBlock("hello")],
        }}
        onSurfaceAction={noop}
        onInspectMessage={(messageId) => inspectedIds.push(messageId)}
      />,
    );

    fireEvent.click(getByTitle("Inspect"));
    expect(inspectedIds).toEqual(["message-1"]);
  });

  test("merges a contiguous thinking + tool_use run into one activity card", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "b-activity",
          role: "assistant",
          contentBlocks: [
            thinkingBlock("why I called the tool"),
            toolUseBlock({
              id: "tc-a",
              name: "bash",
              input: {},
              completedAt: 1,
            }),
            textBlock("the answer"),
          ],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const card = container.querySelector("[data-testid='tool-progress-card']");
    expect(card).not.toBeNull();
    expect(card!.getAttribute("data-item-kinds")).toBe("thinking,toolCall");
    expect(card!.getAttribute("data-item-thinking")).toBe(
      "why I called the tool",
    );
    expect(card!.getAttribute("data-item-tool-ids")).toBe("tc-a");

    const markdowns = container.querySelectorAll("[data-testid='markdown']");
    expect(
      Array.from(markdowns).some((m) => m.textContent === "the answer"),
    ).toBe(true);
  });

  test("merges contiguous thinking + tool runs into one card per run", () => {
    // [thinking, tool, thinking, text, tool, thinking] → two activity runs
    // (split by the text), each one merged card, plus the text between them.
    const message: DisplayMessage = {
      id: "m-merged",
      role: "assistant",
      contentBlocks: [
        thinkingBlock("reason A"),
        toolUseBlock({ id: "tc-a", name: "bash", input: {}, completedAt: 1 }),
        thinkingBlock("reason B"),
        textBlock("the middle answer"),
        toolUseBlock({ id: "tc-b", name: "bash", input: {}, completedAt: 1 }),
        thinkingBlock("reason C"),
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody message={message} onSurfaceAction={noop} />,
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
  });

  test("renders a lone bash tool_use as the inline chip, not a card", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "b-lone-tool",
          role: "assistant",
          contentBlocks: [
            toolUseBlock({
              id: "tc-lone",
              name: "bash",
              input: {},
              completedAt: 1,
            }),
          ],
          timestamp: 1_000,
        }}
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

  test("renders images returned by an assistant tool result", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-img",
      name: "media_generate_image",
      input: { prompt: "diagram" },
      result: "Generated 2 images",
      imageData: "img-a",
      imageDataList: ["img-a", "img-b"],
      completedAt: 1,
    };
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-generated-images",
          role: "assistant",
          contentBlocks: [toolUseBlock(toolCall)],
          toolCalls: [toolCall],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const images = container.querySelectorAll(
      "[data-testid='tool-result-image']",
    );
    expect(images.length).toBe(2);
    expect(images[0]!.getAttribute("src")).toBe("data:image/png;base64,img-a");
    expect(images[1]!.getAttribute("src")).toBe("data:image/png;base64,img-b");
  });

  test("infers non-png MIME types for assistant tool-result images", () => {
    const jpegData = "/9j/4AAQSkZJRgABAQAAAQABAAD";
    const toolCall: ChatMessageToolCall = {
      id: "tc-jpeg",
      name: "media_generate_image",
      input: { prompt: "photo" },
      result: "Generated 1 image",
      imageDataList: [jpegData],
      completedAt: 1,
    };
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-generated-jpeg",
          role: "assistant",
          contentBlocks: [toolUseBlock(toolCall)],
          toolCalls: [toolCall],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const image = container.querySelector("[data-testid='tool-result-image']");
    expect(image?.getAttribute("src")).toBe(
      `data:image/jpeg;base64,${jpegData}`,
    );
  });

  test("mid-turn tool-result images are keyboard-operable and named from the tool", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-fileread",
      name: "file_read",
      input: { path: "/tmp/diagram.png" },
      result: "Read 1 image",
      imageDataList: ["img-a"],
      completedAt: 1,
    };
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-fileread-image",
          role: "assistant",
          contentBlocks: [toolUseBlock(toolCall)],
          toolCalls: [toolCall],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const image = container.querySelector("[data-testid='tool-result-image']");
    const clickable = image?.closest("[role='button']");
    expect(clickable).not.toBeNull();
    // Filename mirrors the daemon's `toolNameToFilePrefix` (`file_read` →
    // `file-read.png`), surfaced as the accessible label and download label.
    expect(clickable!.getAttribute("aria-label")).toBe("file-read.png");
    expect(clickable!.getAttribute("tabindex")).toBe("0");
    const download = container.querySelector(
      "[aria-label='Download file-read.png']",
    );
    expect(download).not.toBeNull();
  });

  test("clicking a mid-turn tool-result image opens the shared preview", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-open",
      name: "media_generate_image",
      input: { prompt: "diagram" },
      result: "Generated 1 image",
      imageDataList: ["img-a"],
      completedAt: 1,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <TranscriptMessageBody
          message={{
            id: "m-open-preview",
            role: "assistant",
            contentBlocks: [toolUseBlock(toolCall)],
            toolCalls: [toolCall],
            timestamp: 1_000,
          }}
          onSurfaceAction={noop}
        />
      </QueryClientProvider>,
    );

    expect(document.querySelector("[role='dialog']")).toBeNull();
    const clickable = container
      .querySelector("[data-testid='tool-result-image']")
      ?.closest("[role='button']");
    fireEvent.click(clickable!);

    // The reused AttachmentPreviewModal portals into document.body.
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-label")).toBe(
      "Preview of media-generate-image.png",
    );
  });

  test("downloading a mid-turn tool-result image saves the data-URL bytes", async () => {
    saveFileMock.mockClear();
    const toolCall: ChatMessageToolCall = {
      id: "tc-dl",
      name: "file_read",
      input: { path: "/tmp/shot.png" },
      result: "Read 1 image",
      imageDataList: ["img-a"],
      completedAt: 1,
    };
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-download-image",
          role: "assistant",
          contentBlocks: [toolUseBlock(toolCall)],
          toolCalls: [toolCall],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const download = container.querySelector(
      "[aria-label='Download file-read.png']",
    );
    fireEvent.click(download!);
    await waitFor(() => {
      expect(saveFileMock).toHaveBeenCalledWith(
        "data:image/png;base64,img-a",
        "file-read.png",
      );
    });
  });

  test("a tool + thinking run still renders the boxed activity card", () => {
    // A run with more than one card item (tool + thinking) is NOT a lone tool,
    // so it stays the boxed card rather than collapsing to the inline chip.
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-tool-thinking",
          role: "assistant",
          contentBlocks: [
            toolUseBlock({
              id: "tc-mix",
              name: "bash",
              input: {},
              completedAt: 1,
            }),
            thinkingBlock("reasoning about the tool"),
            textBlock("done"),
          ],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    expect(
      container.querySelector("[data-testid='tool-progress-card']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='inline-tool-link']"),
    ).toBeNull();
  });

  test("renders a pure-thinking run as an inline SingleActivity, not a card", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "b-thinking",
          role: "assistant",
          contentBlocks: [thinkingBlock("just reasoning")],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    expect(
      container.querySelector("[data-testid='thought-process-link']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Thought process");
    expect(
      container.querySelector("[data-testid='tool-progress-card']"),
    ).toBeNull();
  });

  test("a pure-thinking run renders inline while a later lone tool renders as a chip", () => {
    // The first run before the text is pure thinking; a lone bash tool follows
    // the text and must render as the compact inline chip, not a boxed card.
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "m-pure-thinking",
          role: "assistant",
          contentBlocks: [
            thinkingBlock("just reasoning"),
            textBlock("answer"),
            toolUseBlock({
              id: "tc-a",
              name: "bash",
              input: {},
              completedAt: 1,
            }),
          ],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

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

  test("renders a 'Thought process' link for completed reasoning followed by text", () => {
    // GIVEN a persisted assistant turn whose reasoning precedes its answer,
    // with no interleaved tool call
    // WHEN it is rendered as a settled row
    const html = renderMessage({
      id: "m-think",
      role: "assistant",
      contentBlocks: [
        thinkingBlock("chain of thought"),
        textBlock("the answer"),
      ],
      timestamp: 1_000,
    });

    // THEN the reasoning renders as a completed SingleActivity, not a
    // perpetually-streaming "Thinking" link
    expect(html).toContain("Thought process");
    expect(html).not.toContain("Thinking");
  });

  test("labels trailing reasoning as 'Thinking' while the row is live", () => {
    // GIVEN an assistant row mid-reasoning: a thinking block is the last
    // content with no text or tool output after it yet
    // WHEN it is rendered as the in-flight turn (isStreaming)
    const html = renderMessage(
      {
        id: "m-think-live",
        role: "assistant",
        contentBlocks: [thinkingBlock("reasoning in progress")],
        timestamp: 1_000,
      },
      { isStreaming: true },
    );

    // THEN the link reads as still-streaming ("Thinking"), not the settled
    // "Thought process".
    expect(html).toContain("Thinking");
    expect(html).not.toContain("Thought process");
  });

  test("labels trailing reasoning of a completed turn as 'Thought process'", () => {
    // GIVEN a persisted/completed assistant turn that ends in reasoning with
    // nothing after it
    // WHEN it is rendered as a settled row (not streaming)
    const html = renderMessage({
      id: "m-think-done",
      role: "assistant",
      contentBlocks: [thinkingBlock("reasoning that finished")],
      timestamp: 1_000,
    });

    // THEN the trailing link reads as finished, not perpetually streaming
    expect(html).toContain("Thought process");
    expect(html).not.toContain("Thinking");
  });

  test("renders a surface straight off its content block", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "b-surface",
          role: "assistant",
          contentBlocks: [surfaceBlock("s-1")],
          timestamp: 1_000,
        }}
        onSurfaceAction={noop}
      />,
    );

    const surface = container.querySelector("[data-testid='surface']");
    expect(surface).not.toBeNull();
    expect(surface!.getAttribute("data-surface-id")).toBe("s-1");
  });

  test("a task-progress surface renders inline after the merged activity card", () => {
    const message: DisplayMessage = {
      id: "m-activity-inline",
      role: "assistant",
      contentBlocks: [
        thinkingBlock("reasoning"),
        toolUseBlock({ id: "tc-1", name: "bash", input: {}, completedAt: 1 }),
        { type: "surface", surface: taskProgressSurface("tps-1") },
        textBlock("all done"),
      ],
      timestamp: 1_000,
    };

    const { container } = render(
      <TranscriptMessageBody message={message} onSurfaceAction={noop} />,
    );

    // No legacy summary card.
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

  test("renders user text and an image attachment inside a single bubble", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u1",
          role: "user",
          contentBlocks: [textBlock("look at this")],
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

    // The separate assistant strip is not rendered for user messages.
    expect(container.querySelector("[data-testid='attachments']")).toBeNull();
  });

  test("renders an attachment-only user message inside a single bubble", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u2",
          role: "user",
          contentBlocks: [],
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

  test("vellum link click matches the decoded path basename for bare labels", () => {
    downloadAttachmentMock.mockClear();
    render(
      <TranscriptMessageBody
        message={{
          id: "a-link",
          role: "assistant",
          contentBlocks: [textBlock("grab it")],
          attachments: [
            {
              id: "att-enc",
              filename: "qa shot.png",
              mimeType: "image/png",
              sizeBytes: 99,
              previewUrl: null,
            },
          ],
        }}
        onSurfaceAction={noop}
      />,
    );

    // Bare label + percent-encoded path: the daemon stored the DECODED
    // basename ("qa shot.png"), so the click must decode before matching.
    lastVellumLinkClick?.(
      "vellum://workspace/scratch/qa%20shot.png",
      "desktop",
    );
    expect(downloadAttachmentMock).toHaveBeenCalledTimes(1);
    expect(
      (downloadAttachmentMock.mock.calls[0] as unknown[])[0],
    ).toMatchObject({ id: "att-enc" });
  });

  test("vellum link click still matches link text and raw basename", () => {
    downloadAttachmentMock.mockClear();
    render(
      <TranscriptMessageBody
        message={{
          id: "a-link2",
          role: "assistant",
          contentBlocks: [textBlock("two links")],
          attachments: [
            {
              id: "att-label",
              filename: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 10,
              previewUrl: null,
            },
            {
              id: "att-raw",
              filename: "qa%ZZshot.png",
              mimeType: "image/png",
              sizeBytes: 11,
              previewUrl: null,
            },
          ],
        }}
        onSurfaceAction={noop}
      />,
    );

    // Link text still wins when it names the attachment.
    lastVellumLinkClick?.("vellum://workspace/out/final.pdf", "report.pdf");
    expect(
      (downloadAttachmentMock.mock.calls[0] as unknown[])[0],
    ).toMatchObject({ id: "att-label" });

    // Malformed percent-encoding: decodeURIComponent throws, raw basename
    // fallback still finds the attachment.
    lastVellumLinkClick?.("vellum://workspace/qa%ZZshot.png", "shot");
    expect(
      (downloadAttachmentMock.mock.calls[1] as unknown[])[0],
    ).toMatchObject({ id: "att-raw" });
  });

  test("renders assistant attachments via the separate MessageAttachments strip", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "a1",
          role: "assistant",
          contentBlocks: [textBlock("here you go")],
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

    // Assistant path: separate strip renders, no surface-lift bubble.
    expect(
      container.querySelector("[data-testid='attachments']"),
    ).not.toBeNull();
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
          contentBlocks: [textBlock("do this"), surfaceBlock("s-1")],
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

  test("preserves block order for a [surface, text] user message (surface before text, outside the bubble)", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u-order-1",
          role: "user",
          contentBlocks: [surfaceBlock("s-1"), textBlock("after surface")],
        }}
        onSurfaceAction={noop}
      />,
    );

    const surface = container.querySelector("[data-testid='surface']");
    const markdown = container.querySelector("[data-testid='markdown']");
    expect(surface).not.toBeNull();
    expect(markdown?.textContent).toBe("after surface");

    // DOM order matches block order: surface appears before the text.
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

  test("preserves block order for an interleaved [text, tool, text] user message (tool between text, outside bubbles)", () => {
    const { container } = render(
      <TranscriptMessageBody
        message={{
          id: "u-order-2",
          role: "user",
          contentBlocks: [
            textBlock("before tool"),
            toolUseBlock({
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            }),
            textBlock("after tool"),
          ],
        }}
        onSurfaceAction={noop}
      />,
    );

    const markdowns = container.querySelectorAll("[data-testid='markdown']");
    // A lone non-web tool renders as the compact inline chip, not a boxed card.
    const toolChip = container.querySelector(
      "[data-testid='inline-tool-link']",
    );
    expect(markdowns.length).toBe(2);
    expect(markdowns[0]!.textContent).toBe("before tool");
    expect(markdowns[1]!.textContent).toBe("after tool");
    expect(toolChip).not.toBeNull();

    // DOM order matches block order: text → tool → text.
    expect(
      markdowns[0]!.compareDocumentPosition(toolChip!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      toolChip!.compareDocumentPosition(markdowns[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The tool chip is never wrapped inside a surface-lift text bubble — the
    // text runs render inline and the chip sits between them.
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
          contentBlocks: [
            toolUseBlock({
              id: "tc-1",
              name: "bash",
              input: {},
              completedAt: 1,
            }),
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
});

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

// ---------------------------------------------------------------------------
// Generic inline card (PR 10): each render helper maps resolved ids → the
// generic `InlineProcessCardRow` (stubbed above) with the right descriptor,
// and preserves the transcript's existing `onOpen`/`onStop` handler wiring.
// ---------------------------------------------------------------------------

describe("TranscriptMessageBody — generic inline process cards", () => {
  function renderBody(
    message: DisplayMessage,
    props: {
      onWorkflowClick?: (id: string) => void;
      onStopWorkflow?: (id: string) => void;
    } = {},
  ) {
    return render(
      <TranscriptMessageBody
        message={message}
        onSurfaceAction={noop}
        onWorkflowClick={props.onWorkflowClick}
        onStopWorkflow={props.onStopWorkflow}
      />,
    );
  }

  test("renders the workflow descriptor row and wires open + stop", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-wf",
      name: "run_workflow",
      input: {},
      result: JSON.stringify({ runId: "wf-1" }),
      completedAt: 1,
    };
    const opened: string[] = [];
    const stopped: string[] = [];
    const { getByTestId } = renderBody(
      {
        id: "m-wf",
        role: "assistant",
        contentBlocks: [toolUseBlock(toolCall)],
        toolCalls: [toolCall],
        timestamp: 1_000,
      },
      {
        onWorkflowClick: (id) => opened.push(id),
        onStopWorkflow: (id) => stopped.push(id),
      },
    );

    const row = getByTestId("inline-process-card");
    expect(row.getAttribute("data-process-kind")).toBe("workflow");
    expect(row.getAttribute("data-process-id")).toBe("wf-1");
    expect(row.getAttribute("data-has-stop")).toBe("true");

    fireEvent.click(getByTestId("inline-process-card-open"));
    fireEvent.click(getByTestId("inline-process-card-stop"));
    expect(opened).toEqual(["wf-1"]);
    expect(stopped).toEqual(["wf-1"]);
  });

  test("renders the ACP-run descriptor row and wires open + stop", () => {
    stopAcpRunMock.mockClear();
    const toolCall: ChatMessageToolCall = {
      id: "tc-acp",
      name: "acp_spawn",
      input: {},
      result: JSON.stringify({ acpSessionId: "acp-1" }),
      completedAt: 1,
    };
    const { getByTestId } = renderBody({
      id: "m-acp",
      role: "assistant",
      contentBlocks: [toolUseBlock(toolCall)],
      toolCalls: [toolCall],
      timestamp: 1_000,
    });

    const row = getByTestId("inline-process-card");
    expect(row.getAttribute("data-process-kind")).toBe("acp-run");
    expect(row.getAttribute("data-process-id")).toBe("acp-1");
    expect(row.getAttribute("data-has-stop")).toBe("true");

    fireEvent.click(getByTestId("inline-process-card-stop"));
    expect(stopAcpRunMock).toHaveBeenCalledWith("acp-1");
  });

  test("renders the background-task descriptor row and wires open + stop", () => {
    stopBackgroundTaskMock.mockClear();
    const toolCall: ChatMessageToolCall = {
      id: "tc-bg",
      name: "bash",
      input: { background: true },
      result: JSON.stringify({ backgrounded: true, id: "bg-1" }),
      completedAt: 1,
    };
    const { getByTestId } = renderBody({
      id: "m-bg",
      role: "assistant",
      contentBlocks: [toolUseBlock(toolCall)],
      toolCalls: [toolCall],
      timestamp: 1_000,
    });

    const row = getByTestId("inline-process-card");
    expect(row.getAttribute("data-process-kind")).toBe("background-task");
    expect(row.getAttribute("data-process-id")).toBe("bg-1");
    expect(row.getAttribute("data-has-stop")).toBe("true");

    fireEvent.click(getByTestId("inline-process-card-stop"));
    expect(stopBackgroundTaskMock).toHaveBeenCalledWith("bg-1");
  });
});
