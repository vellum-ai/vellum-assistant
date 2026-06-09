/**
 * Tests for the inline single-tool chip `InlineToolLink`. Covers the derived
 * tool icon + label, the risk badge, the toggle-drawer click contract (via the
 * shared `toolDetailPayloadFromToolCall` payload), and the active state when
 * the store's `activeToolDetail` matches this call.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

// The viewer store imports the generated daemon SDK, which isn't built in
// CI/worktree checkouts. Stub the two endpoints it references so the module
// loads. Component + store are imported dynamically below so the mock is
// registered first.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => ({ data: undefined }),
  documentsByIdGet: async () => ({ data: undefined }),
}));

const { InlineToolLink } = await import(
  "@/domains/chat/components/inline-activity-link/inline-tool-link"
);
const { useViewerStore } = await import("@/stores/viewer-store");
const { toolDetailPayloadFromToolCall } = await import(
  "@/domains/chat/utils/tool-call-card-utils"
);

const startedAt = 1_717_000_000_000;

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return {
    id: "tc-1",
    name: "bash",
    input: { command: "date", activity: "Checking the current time" },
    riskLevel: "low",
    startedAt,
    completedAt: startedAt + 2_000,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  useViewerStore.setState({ activeToolDetail: null, mainView: "chat" });
});

describe("InlineToolLink", () => {
  test("renders the derived label, tool icon, chevron, and risk badge", () => {
    const { getByTestId, getByText, container } = render(
      <InlineToolLink toolCall={makeToolCall()} />,
    );

    expect(getByTestId("inline-tool-link")).toBeTruthy();
    // `activity` wins as the label.
    expect(getByText("Checking the current time")).toBeTruthy();
    // "Low" risk badge.
    expect(getByTestId("risk-badge")).toBeTruthy();
    expect(getByText("Low")).toBeTruthy();
    // Tool glyph (leading) + ChevronRight (trailing).
    expect(container.querySelectorAll("svg").length).toBe(2);
  });

  test("clicking toggles the tool-detail drawer with the shared payload", () => {
    const toolCall = makeToolCall();
    const { getByTestId } = render(<InlineToolLink toolCall={toolCall} />);

    fireEvent.click(getByTestId("inline-tool-link"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail).toEqual(toolDetailPayloadFromToolCall(toolCall));
    expect(useViewerStore.getState().mainView).toBe("tool-detail");

    // Clicking the already-open chip closes the drawer (toggle).
    fireEvent.click(getByTestId("inline-tool-link"));
    expect(useViewerStore.getState().activeToolDetail).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("renders active when the store's activeToolDetail matches this call", () => {
    const toolCall = makeToolCall({ id: "tc-active" });
    useViewerStore.setState({
      mainView: "tool-detail",
      activeToolDetail: toolDetailPayloadFromToolCall(toolCall),
    });

    const { getByTestId } = render(<InlineToolLink toolCall={toolCall} />);
    expect(getByTestId("inline-tool-link").getAttribute("data-active")).toBe(
      "true",
    );
  });
});
