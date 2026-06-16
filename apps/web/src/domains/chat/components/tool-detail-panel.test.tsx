/**
 * Tests for `ToolDetailPanel` — the side-drawer body for a tool-call step.
 *
 * Runs under happy-dom (see apps/web/test-setup.ts) so we can render
 * interactively and assert click / clipboard behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { ToolDetailPanel } from "@/domains/chat/components/tool-detail-panel";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const noop = () => {};

function makeDetail(overrides: Partial<ToolDetailPayload> = {}): ToolDetailPayload {
  return {
    toolCallId: "tc-1",
    toolName: "subagent_spawn",
    title: "Spawning subagent",
    activity: "Spawning subagent to research Toronto's location",
    input: { label: "toronto-location", role: "researcher" },
    result: '{"summary":"Toronto is in Ontario, Canada."}',
    status: "completed",
    riskLevel: "low",
    ...overrides,
  };
}

let writeText: ReturnType<typeof mock>;

beforeEach(() => {
  writeText = mock(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useChatSessionStore.getState().setMessages([]);
  });
});

function assistantThinkingMessage(thinking: string): DisplayMessage {
  return {
    id: "msg-1",
    role: "assistant",
    contentBlocks: [{ type: "thinking", thinking }],
  };
}

describe("ToolDetailPanel", () => {
  test("renders the activity title, friendly tool name, input JSON and output", () => {
    const { getByText, getAllByText, container } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    // Activity renders in both the header title and the technical-details body.
    expect(
      getAllByText("Spawning subagent to research Toronto's location").length,
    ).toBeGreaterThan(0);
    // Friendly tool name (title-cased from snake_case).
    expect(getByText("Subagent Spawn")).toBeDefined();
    // Input JSON + output appear inside <pre> blocks.
    const text = container.textContent ?? "";
    expect(text).toContain('"toronto-location"');
    expect(text).toContain("Toronto is in Ontario, Canada.");
  });

  test("hides the Output section when result is empty", () => {
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail({ result: "" })} onClose={noop} />,
    );

    expect(queryByText("Output")).toBeNull();
  });

  test("hides the Output section when result is undefined", () => {
    const { queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "completed" })}
        onClose={noop}
      />,
    );

    expect(queryByText("Output")).toBeNull();
  });

  test("shows a Running placeholder while running with no result", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByText("Running…")).toBeDefined();
  });

  test("clicking close fires onClose", () => {
    const onClose = mock(() => {});
    const { getByLabelText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText("Close tool details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("copy button writes the content to the clipboard", () => {
    const { getAllByLabelText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    // Two copy buttons: one for input, one for output.
    const copyButtons = getAllByLabelText("Copy");
    expect(copyButtons.length).toBe(2);

    fireEvent.click(copyButtons[0]!);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("thinking variant renders the reasoning markdown without input/output sections", () => {
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingText: "I should first check the directory listing.",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // Title + full reasoning text are present.
    expect(getByText("Thinking")).toBeDefined();
    expect(
      getByText("I should first check the directory listing."),
    ).toBeDefined();
    // No tool sections.
    expect(queryByText("Technical details")).toBeNull();
    expect(queryByText("Output")).toBeNull();
    // No risk badge.
    expect(queryByText("Subagent Spawn")).toBeNull();
  });

  test("thinking variant streams live as the source message's reasoning grows", () => {
    act(() => {
      useChatSessionStore
        .getState()
        .setMessages([assistantThinkingMessage("First thought.")]);
    });
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      thinkingMessageId: "msg-1",
      thinkingGroupIndex: 0,
      // The snapshot is stale on purpose — the live message is the source.
      thinkingText: "First thought.",
    });
    const { container } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(container.textContent ?? "").toContain("First thought.");

    // A new `assistant_thinking_delta` lands: the drawer reflects it without a
    // re-open.
    act(() => {
      useChatSessionStore
        .getState()
        .setMessages([
          assistantThinkingMessage("First thought.\nSecond thought."),
        ]);
    });
    expect(container.textContent ?? "").toContain("Second thought.");
  });

  test("thinking variant indexes a single run for a MultiActivityGroup pill", () => {
    act(() => {
      useChatSessionStore.getState().setMessages([
        {
          id: "msg-1",
          role: "assistant",
          // Two reasoning runs split by a tool call — the panel must show only
          // the addressed run, not the joined group.
          contentBlocks: [
            { type: "thinking", thinking: "Run one." },
            {
              type: "tool_use",
              toolCall: { id: "tc-1", name: "bash", input: {} },
            },
            { type: "thinking", thinking: "Run two." },
          ],
        },
      ]);
    });
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingMessageId: "msg-1",
      thinkingGroupIndex: 0,
      thinkingItemIndex: 1,
      thinkingText: "Run two.",
    });
    const { container } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Run two.");
    expect(text).not.toContain("Run one.");
  });

  test("thinking variant falls back to the snapshot when the message is gone", () => {
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      thinkingMessageId: "missing",
      thinkingGroupIndex: 0,
      thinkingText: "Snapshot reasoning.",
    });
    const { container } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(container.textContent ?? "").toContain("Snapshot reasoning.");
  });

  test("thinking variant close button fires onClose", () => {
    const onClose = mock(() => {});
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingText: "Reasoning.",
    });
    const { getByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText("Close tool details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
