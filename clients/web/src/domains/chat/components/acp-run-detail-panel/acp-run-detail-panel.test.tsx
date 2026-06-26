/**
 * Tests for `AcpRunDetailPanel` — a thin delegator that renders an ACP run as
 * the Devin-style chat view (`AcpRunChatView`). The conversation's own behavior
 * (streaming, tool cards, steering, terminal states) is covered by
 * acp-run-chat-view.test.tsx; here we only assert the panel wires the run and
 * close handler through to it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AcpRunEntry } from "@/domains/chat/acp-run-store";

// The real actions module pulls in the daemon client; mock at that boundary so
// importing the chat view stays in-process. Import the panel after it registers.
mock.module("@/domains/chat/utils/acp-run-actions", () => ({
  steerAcpRun: mock(async () => ({ acpSessionId: "acp-1", steered: true })),
  stopAcpRun: mock(async () => {}),
}));

const { AcpRunDetailPanel } = await import(
  "@/domains/chat/components/acp-run-detail-panel/acp-run-detail-panel"
);

const noop = () => {};

function makeEntry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    task: "Research the thing",
    status: "running",
    startedAt: 0,
    usedTokens: 0,
    contextSize: 0,
    events: [],
    ...overrides,
  };
}

afterEach(cleanup);

describe("AcpRunDetailPanel", () => {
  test("renders the run as the chat conversation", () => {
    render(<AcpRunDetailPanel entry={makeEntry()} onClose={noop} />);
    expect(screen.getByTestId("acp-chat-conversation")).toBeDefined();
    expect(screen.getByText("claude")).toBeDefined();
  });

  test("close button fires onClose", () => {
    let closed = 0;
    render(
      <AcpRunDetailPanel
        entry={makeEntry()}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close run detail"));
    expect(closed).toBe(1);
  });
});
