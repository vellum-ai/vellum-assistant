/**
 * End-to-end wiring regression for the streaming "Thinking" shimmer: while the
 * turn phase is in flight, an assistant message whose body is a live reasoning
 * run must render its inline thinking link THROUGH the shimmer treatment —
 * exercising the real chain `useTurnStore.phase` → `LatestTurnRow`
 * (`isStreaming`) → `TranscriptRow` → `TranscriptMessageBody`
 * (`isStreaming && isLastGroup`) → `SingleActivity` (`shimmerLabel`) →
 * `StreamingShimmerText`. The component-level suites each mock a neighbor in
 * this chain, so none of them can catch a broken handoff between layers.
 *
 * Client-side `render` (not static markup) is load-bearing: zustand resolves
 * `useSyncExternalStore`'s server snapshot to the store's INITIAL state, so a
 * static render can never observe a test-injected turn phase.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

mock.module("@/domains/chat/components/message-hover-actions/message-hover-actions", () => ({
  MessageHoverActions: () => <div data-testid="hover-actions" />,
}));

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip", () => ({
  ToolCallChip: () => <div data-testid="tool-call-chip" />,
}));

mock.module("@/components/assistant/surfaces", () => ({
  SurfaceRouter: () => <div data-testid="surface-router" />,
}));

mock.module("@/domains/chat/components/chat-attachments/message-attachments", () => ({
  MessageAttachments: () => <div data-testid="message-attachments" />,
}));


// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

const { LatestTurnRow } = await import(
  "@/domains/chat/transcript/latest-turn-row"
);
const { INITIAL_TURN_STATE, useTurnStore } = await import(
  "@/domains/chat/turn-store"
);
const { textBody, thinkingBodyWithBlocks } = await import(
  "@/domains/chat/utils/message-test-helpers"
);

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { MessageItem } from "@/domains/chat/transcript/types";

function userItem(id: string, content: string): MessageItem {
  const msg: DisplayMessage = { id, role: "user", ...textBody(content) };
  return { kind: "message", key: id, message: msg };
}

function assistantThinkingItem(id: string, reasoning: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "assistant",
    ...thinkingBodyWithBlocks(reasoning),
  };
  return { kind: "message", key: id, message: msg };
}

const noop = () => {};
const sharedProps = { onSurfaceAction: noop };

function renderTurn() {
  return render(
    <LatestTurnRow
      anchorMessage={userItem("u1", "do the thing")}
      responseItems={[assistantThinkingItem("a1", "live reasoning so far")]}
      {...sharedProps}
    />,
  );
}

afterEach(() => {
  cleanup();
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
});

describe("streaming thinking shimmer wiring", () => {
  test("phase 'thinking' → the inline thinking link renders through the shimmer", () => {
    useTurnStore.setState({ phase: "thinking" });
    const { getByTestId, getByText } = renderTurn();
    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByTestId("thought-process-loading")).toBeTruthy();
    expect(getByText("Thinking")).toBeTruthy();
  });

  test("phase 'streaming' → still shimmering", () => {
    useTurnStore.setState({ phase: "streaming" });
    const { getByTestId } = renderTurn();
    expect(getByTestId("thought-process-loading")).toBeTruthy();
  });

  test("idle turn → static 'Thinking' label, no shimmer", () => {
    useTurnStore.setState({ phase: "idle" });
    const { getByTestId, queryByTestId, getByText } = renderTurn();
    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(queryByTestId("thought-process-loading")).toBeNull();
    expect(getByText("Thinking")).toBeTruthy();
  });
});
