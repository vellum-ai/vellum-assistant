/**
 * Tests for the inline `SingleActivity` link — the lone affordance for one step
 * of agent work, in its two variants:
 *
 *   - `variant="thinking"` — an assistant reasoning run. Covers the brain +
 *     chevron glyphs, the "Thought process" label, the drawer-open/toggle click
 *     contract, the streaming loading state (three-dot indicator + "Thinking",
 *     still clickable), and the empty-content render rules.
 *   - `variant="tool"` — a lone renderable tool call. Covers the derived tool
 *     icon + label, the risk badge, the toggle-drawer click contract (via the
 *     shared `toolDetailPayloadFromToolCall` payload), and the active state when
 *     the store's `activeToolDetail` matches this call.
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

const { SingleActivity } = await import(
  "@/domains/chat/components/single-activity/single-activity"
);
const { useViewerStore } = await import("@/stores/viewer-store");
const { toolDetailPayloadFromToolCall } = await import(
  "@/domains/chat/utils/tool-call-card-utils"
);

const CONTENT = "Let me reason about the next step before acting.";
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
  // The click writes to the real viewer store — reset the drawer state between
  // tests so assertions don't bleed across cases.
  useViewerStore.setState({ activeToolDetail: null, mainView: "chat" });
});

describe("SingleActivity — thinking variant", () => {
  test("renders the label, brain icon, and trailing chevron", () => {
    const { getByTestId, getByText, container } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );

    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByText("Thought process")).toBeTruthy();
    // Brain (leading) + ChevronRight (trailing) lucide glyphs.
    expect(container.querySelectorAll("svg").length).toBe(2);
  });

  test("clicking opens the thinking detail drawer with the full reasoning", () => {
    const { getByLabelText } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.kind).toBe("thinking");
    expect(detail?.title).toBe("Thought process");
    expect(detail?.thinkingText).toBe(CONTENT);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });

  test("clicking again toggles the drawer closed", () => {
    const { getByLabelText } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );

    // Open, then click the now-active link to close it.
    fireEvent.click(getByLabelText("View thinking"));
    expect(useViewerStore.getState().mainView).toBe("tool-detail");

    fireEvent.click(getByLabelText("View thinking"));
    expect(useViewerStore.getState().activeToolDetail).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("while streaming, shows the three-dot loader + 'Thinking' (no brain)", () => {
    const { getByTestId, getByText, queryByText, container } = render(
      <SingleActivity variant="thinking" content={CONTENT} isStreaming />,
    );

    expect(getByText("Thinking")).toBeTruthy();
    expect(queryByText("Thought process")).toBeNull();
    // The brain glyph is swapped for the three-dot indicator, so only the
    // trailing chevron remains as an svg.
    expect(getByTestId("thought-process-loading")).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBe(1);
  });

  test("stays clickable while streaming — opens the live reasoning in the drawer", () => {
    const { getByLabelText } = render(
      <SingleActivity variant="thinking" content={CONTENT} isStreaming />,
    );

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.kind).toBe("thinking");
    expect(detail?.thinkingText).toBe(CONTENT);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });

  test("renders while streaming even before any reasoning text arrives", () => {
    const { getByTestId } = render(
      <SingleActivity variant="thinking" content="" isStreaming />,
    );
    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByTestId("thought-process-loading")).toBeTruthy();
  });

  test("renders nothing when content is empty and not streaming", () => {
    const { queryByTestId } = render(
      <SingleActivity variant="thinking" content="" />,
    );
    expect(queryByTestId("thought-process-link")).toBeNull();
  });

  test("renders active when its reasoning is the one open in the drawer", () => {
    useViewerStore.setState({
      mainView: "tool-detail",
      activeToolDetail: {
        kind: "thinking",
        toolCallId: "",
        toolName: "",
        title: "Thought process",
        activity: "",
        input: {},
        status: "completed",
        thinkingText: CONTENT,
      },
    });

    const { getByTestId } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );
    expect(
      getByTestId("thought-process-link").getAttribute("data-active"),
    ).toBe("true");
  });
});

describe("SingleActivity — tool variant", () => {
  test("renders the derived label, tool icon, chevron, and risk badge", () => {
    const { getByTestId, getByText, container } = render(
      <SingleActivity variant="tool" toolCall={makeToolCall()} />,
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

  test("renders the risk badge only when riskLevel is supplied", () => {
    const { queryByTestId } = render(
      <SingleActivity
        variant="tool"
        toolCall={makeToolCall({ riskLevel: undefined })}
      />,
    );
    expect(queryByTestId("risk-badge")).toBeNull();
  });

  test("clicking toggles the tool-detail drawer with the shared payload", () => {
    const toolCall = makeToolCall();
    const { getByTestId } = render(
      <SingleActivity variant="tool" toolCall={toolCall} />,
    );

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

    const { getByTestId } = render(
      <SingleActivity variant="tool" toolCall={toolCall} />,
    );
    expect(getByTestId("inline-tool-link").getAttribute("data-active")).toBe(
      "true",
    );
    expect(getByTestId("inline-tool-link").className).toContain(
      "bg-[var(--surface-active)]",
    );
  });

  test("renders the error tone for a failed call", () => {
    const { getByTestId } = render(
      <SingleActivity
        variant="tool"
        toolCall={makeToolCall({ id: "tc-error", isError: true })}
      />,
    );
    expect(getByTestId("inline-tool-link").className).toContain(
      "text-[var(--system-negative-strong)]",
    );
  });
});
