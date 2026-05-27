/**
 * Tests for the `ChatScrollArea` layout behavior.
 *
 * Verifies the conditional CSS class logic that enables the parent
 * `ChatBody` to center greeting + composer + starters as one group on
 * the empty state (LUM-1566).
 *
 * Uses bun:test + react-dom/server (renderToStaticMarkup) matching the
 * existing project test convention. Child components that require
 * browser APIs or complex hooks are stubbed via `mock.module`.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatScrollAreaProps } from "@/domains/chat/components/chat-scroll-area";

// Stub heavy children that aren't relevant to the layout assertions.
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

// Import after mocks are registered (bun:test hoists mock.module).
import { ChatScrollArea } from "@/domains/chat/components/chat-scroll-area";

function baseProps(
  overrides: Partial<ChatScrollAreaProps> = {},
): ChatScrollAreaProps {
  return {
    isLoadingHistory: false,
    messageCount: 0,
    showMaintenanceRecoveryCard: false,
    showEmptyState: false,
    emptyStateProps: {},
    transcriptRef: null,
    transcriptProps: { messages: [], onScrollToMessage: () => {} } as never,
    ...overrides,
  };
}

describe("ChatScrollArea — empty-state layout (LUM-1566)", () => {
  test("drops flex-1 when showEmptyState is true so the parent can center the group", () => {
    const html = renderToStaticMarkup(
      <ChatScrollArea {...baseProps({ showEmptyState: true })} />,
    );
    // The wrapper must NOT have flex-1 — otherwise it expands to fill
    // the available height and defeats the parent's safe-center.
    expect(html).toContain("relative flex min-h-0 flex-col");
    expect(html).not.toContain("flex-1");
  });

  test("keeps flex-1 when showEmptyState is false so the transcript fills available height", () => {
    const html = renderToStaticMarkup(
      <ChatScrollArea
        {...baseProps({ showEmptyState: false, messageCount: 1 })}
      />,
    );
    expect(html).toContain("flex-1");
  });

  test("renders ChatEmptyState greeting when showEmptyState is true", () => {
    const html = renderToStaticMarkup(
      <ChatScrollArea {...baseProps({ showEmptyState: true })} />,
    );
    // Default greeting from ChatEmptyState
    expect(html).toContain("I&#x27;m here whenever you need me.");
  });

  test("does not render ChatEmptyState when showEmptyState is false", () => {
    const html = renderToStaticMarkup(
      <ChatScrollArea
        {...baseProps({ showEmptyState: false, messageCount: 1 })}
      />,
    );
    expect(html).not.toContain("I&#x27;m here whenever you need me.");
  });
});
