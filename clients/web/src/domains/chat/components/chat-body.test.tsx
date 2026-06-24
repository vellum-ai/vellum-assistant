/**
 * Tests for the `ChatBody` layout behavior.
 *
 * Verifies the conditional CSS class logic and slot rendering that
 * enables centered empty-state layout (LUM-1566): greeting + composer +
 * conversation-starter chips center as one visual group via
 * `justify-content: safe center`.
 *
 * Uses bun:test + react-dom/server (renderToStaticMarkup) matching the
 * existing project test convention. Complex child components are stubbed
 * via `mock.module` so the test focuses on the composition logic inside
 * `ChatBody` itself.
 */

import { describe, expect, mock, test } from "bun:test";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatBodyProps } from "@/domains/chat/components/chat-body";

// Stub child components that require browser APIs or complex hooks.
// NOTE: Do NOT mock chat-scroll-area itself — that leaks across test
// files via bun's shared module registry and breaks chat-scroll-area's
// own tests. Instead, mock ChatScrollArea's deep dependencies.
mock.module(
  "@/domains/chat/transcript/transcript",
  () => ({
    Transcript: () => <div data-testid="transcript">TRANSCRIPT</div>,
  }),
);

mock.module(
  "@/domains/chat/components/maintenance-recovery-card",
  () => ({
    MaintenanceRecoveryCard: () => <div>MAINTENANCE</div>,
  }),
);

mock.module("@/domains/chat/components/chat-skeleton", () => ({
  ChatSkeleton: () => <div>SKELETON</div>,
}));

mock.module(
  "@/domains/chat/components/scroll-to-latest-button",
  () => ({
    ScrollToLatestButton: ({ onClick }: { onClick: () => void }) => (
      <button data-testid="scroll-to-latest" onClick={onClick}>
        SCROLL_TO_LATEST
      </button>
    ),
  }),
);


mock.module("@vellumai/design-library", () => ({
  Button: ({
    children,
    iconOnly,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{iconOnly ?? children}</button>
  ),
  Notice: ({
    children,
    actions,
  }: {
    children?: ReactNode;
    actions?: ReactNode;
  }) => (
    <div data-testid="notice">
      {children}
      {actions ? <div data-testid="notice-actions">{actions}</div> : null}
    </div>
  ),
  Card: {
    Root: ({
      children,
      padding: _padding,
      bordered: _bordered,
      elevated: _elevated,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
      bordered?: unknown;
      elevated?: unknown;
    }) => <div {...props}>{children}</div>,
    Body: ({
      children,
      padding: _padding,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  ResizablePanel: () => <div data-testid="resizable-panel" />,
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

mock.module(
  "@/domains/chat/refresh-feedback-pill",
  () => ({
    RefreshFeedbackPill: () => <div>REFRESH_PILL</div>,
  }),
);

mock.module(
  "@/domains/chat/components/question-prompt-slot",
  () => ({
    QuestionPromptSlot: () => <div data-testid="question-prompt-slot" />,
  }),
);

// Import after mocks are registered.
const { ChatBody } = await import("@/domains/chat/components/chat-body");

const noop = () => {};
const noopDrag = () => {};

function baseProps(
  overrides: Partial<ChatBodyProps> = {},
): ChatBodyProps {
  return {
    variant: "main",
    scrollAreaProps: {
      isLoadingHistory: false,
      messageCount: 0,
      showMaintenanceRecoveryCard: false,
      showEmptyState: false,
      emptyStateProps: {},
      transcriptRef: null,
      transcriptProps: { messages: [], onScrollToMessage: noop } as never,
    },
    composerSlot: <div data-testid="composer">COMPOSER</div>,
    onStopGenerating: noop,
    dragHandlers: {
      onDragEnter: noopDrag,
      onDragOver: noopDrag,
      onDragLeave: noopDrag,
      onDrop: noopDrag,
    },
    isAttachmentDragOver: false,
    showScrollToLatest: false,
    onScrollToLatest: noop,
    refreshFeedback: null,
    onDismissRefreshFeedback: noop,
    onRetryRefresh: noop,
    genericChatError: null,
    isChannelReadonly: false,
    ...overrides,
  };
}

function withEmptyState(
  overrides: Partial<ChatBodyProps> = {},
): ChatBodyProps {
  return baseProps({
    scrollAreaProps: {
      ...baseProps().scrollAreaProps,
      showEmptyState: true,
    },
    ...overrides,
  });
}

describe("ChatBody — empty-state centering (LUM-1566)", () => {
  test("applies safe_center and overflow-y-auto when empty state is visible", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...withEmptyState()} />,
    );
    expect(html).toContain("[justify-content:safe_center]");
    expect(html).toContain("overflow-y-auto");
  });

  test("does NOT apply safe_center or overflow-y-auto when empty state is hidden", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps()} />,
    );
    expect(html).not.toContain("[justify-content:safe_center]");
    expect(html).not.toContain("overflow-y-auto");
  });

  test("uses flex-1 in outer class for main variant", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ variant: "main" })} />,
    );
    // The outer container class for the main variant.
    expect(html).toContain("relative flex min-h-0 flex-1 flex-col");
  });

  test("uses h-full in outer class for side-panel variant", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ variant: "side-panel" })} />,
    );
    // The outer container class for the side-panel variant.
    expect(html).toContain("relative flex h-full min-h-0 flex-col");
  });
});

describe("ChatBody — banner overlay suppression (LUM-1566)", () => {
  test("suppresses banner overlay on empty state to prevent greeting overlap", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    // The banner node is passed but the overlay container should not
    // render it on the empty state — it would overlap the greeting.
    expect(html).not.toContain("BANNER_CONTENT");
  });

  test("renders banner overlay when empty state is hidden and bannerSlot is provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    expect(html).toContain("BANNER_CONTENT");
  });
});

describe("ChatBody — startersSlot rendering", () => {
  test("renders startersSlot content when provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          startersSlot: (
            <div data-testid="starters">STARTER_CHIPS</div>
          ),
        })}
      />,
    );
    expect(html).toContain("STARTER_CHIPS");
  });

  test("omits starters when startersSlot is undefined", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...withEmptyState()} />,
    );
    expect(html).not.toContain("STARTER_CHIPS");
  });

});

describe("ChatBody — active subagents overlay slot", () => {
  const activeSubagentsSlot = (
    <div data-testid="active-subagents-slot">ACTIVE_SUBAGENTS</div>
  );

  test("renders the slot top-center when scrolled up and slot is provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          activeSubagentsSlot,
        })}
      />,
    );
    expect(html).toContain("ACTIVE_SUBAGENTS");
  });

  test("does NOT render the slot when pinned (showScrollToLatest false)", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: false,
          activeSubagentsSlot,
        })}
      />,
    );
    expect(html).not.toContain("ACTIVE_SUBAGENTS");
  });

  test("does NOT render the slot on the empty state", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          showScrollToLatest: true,
          activeSubagentsSlot,
        })}
      />,
    );
    expect(html).not.toContain("ACTIVE_SUBAGENTS");
  });

  test("Go-to-Newest bottom overlay still renders alongside the slot (no regression)", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          activeSubagentsSlot,
        })}
      />,
    );
    expect(html).toContain("SCROLL_TO_LATEST");
    expect(html).toContain("ACTIVE_SUBAGENTS");
  });
});

describe("ChatBody — read-only cancellation", () => {
  test("renders the read-only banner without a stop control while idle", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          isChannelReadonly: true,
        })}
      />,
    );

    expect(html).toContain("Read-only conversation");
    expect(html).not.toContain('aria-label="Stop generating"');
    expect(html).not.toContain("COMPOSER");
  });

  test("renders the stop control for an active read-only turn", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          isChannelReadonly: true,
          canStopGenerating: true,
        })}
      />,
    );

    expect(html).toContain("Read-only conversation");
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).toContain('title="Stop generation"');
    expect(html).not.toContain("COMPOSER");
  });
});

describe("ChatBody — channel footer slot", () => {
  test("renders channelFooterSlot immediately above the composer", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          channelFooterSlot: (
            <div data-testid="channel-footer">CHANNEL_FOOTER</div>
          ),
        })}
      />,
    );

    expect(html).toContain("CHANNEL_FOOTER");
    expect(html.indexOf("CHANNEL_FOOTER")).toBeLessThan(
      html.indexOf("COMPOSER"),
    );
  });
});

describe("ChatBody — generic chat error Notice (dismiss UX)", () => {
  // The Notice is rendered as an inline error banner above the composer.
  // The banner has a "Go to Doctor" action and a "Dismiss" button as a
  // second action (so the user has a real way to close the banner).

  test("renders a Dismiss button when genericChatError + onDismissChatError are both provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: {
            message: "Model doesn't support image input.",
            actions: (
              <a href="/assistant/settings/debug?tab=doctor">Go to Doctor</a>
            ),
          },
          onDismissChatError: () => {},
        })}
      />,
    );

    expect(html).toContain("Go to Doctor");
    expect(html).toContain("Dismiss");
  });

  test("does NOT render the Dismiss button when onDismissChatError is omitted", () => {
    // Defensive: don't silently show a Dismiss button that does nothing.
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: { message: "Something went wrong." },
        })}
      />,
    );

    expect(html).not.toContain("Dismiss");
  });

  test("does not render the error banner at all when genericChatError is null", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ genericChatError: null })} />,
    );

    expect(html).not.toContain(">Dismiss<");
  });
});
