/**
 * Tests for the inline `ThoughtProcessLink` — the minimal, container-less
 * affordance that renders an assistant reasoning run (the single thinking
 * affordance for both the interleaved and legacy pure-reasoning paths). Covers
 * the label, the brain + chevron glyphs, the drawer-open click contract, the
 * streaming loading state (three-dot indicator + "Thinking", still clickable),
 * and the empty-content render rules.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

// The viewer store imports the generated daemon SDK, which isn't built in
// CI/worktree checkouts. Stub the two endpoints it references so the module
// loads; the component never invokes them. Mirrors the `mock.module` pattern
// in `activity-run-card.test.tsx`. Component + store are imported dynamically
// below so the mock is registered first.
import { mock } from "bun:test";

mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => ({ data: undefined }),
  documentsByIdGet: async () => ({ data: undefined }),
}));

const { ThoughtProcessLink } = await import(
  "@/domains/chat/components/thought-process-link/thought-process-link"
);
const { useViewerStore } = await import("@/stores/viewer-store");

const CONTENT = "Let me reason about the next step before acting.";

afterEach(() => {
  cleanup();
  // The click writes to the real viewer store — reset the drawer state
  // between tests so assertions don't bleed across cases.
  useViewerStore.setState({ activeToolDetail: null, mainView: "chat" });
});

describe("ThoughtProcessLink", () => {
  test("renders the label, brain icon, and trailing chevron", () => {
    const { getByTestId, getByText, container } = render(
      <ThoughtProcessLink content={CONTENT} />,
    );

    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByText("Thought process")).toBeTruthy();
    // Brain (leading) + ChevronRight (trailing) lucide glyphs.
    expect(container.querySelectorAll("svg").length).toBe(2);
  });

  test("clicking opens the thinking detail drawer with the full reasoning", () => {
    const { getByLabelText } = render(<ThoughtProcessLink content={CONTENT} />);

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.kind).toBe("thinking");
    expect(detail?.title).toBe("Thought process");
    expect(detail?.thinkingText).toBe(CONTENT);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });

  test("clicking again toggles the drawer closed", () => {
    const { getByLabelText } = render(<ThoughtProcessLink content={CONTENT} />);

    // Open, then click the now-active link to close it.
    fireEvent.click(getByLabelText("View thinking"));
    expect(useViewerStore.getState().mainView).toBe("tool-detail");

    fireEvent.click(getByLabelText("View thinking"));
    expect(useViewerStore.getState().activeToolDetail).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("while streaming, shows the three-dot loader + 'Thinking' (no brain)", () => {
    const { getByTestId, getByText, queryByText, container } = render(
      <ThoughtProcessLink content={CONTENT} isStreaming />,
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
      <ThoughtProcessLink content={CONTENT} isStreaming />,
    );

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.kind).toBe("thinking");
    expect(detail?.thinkingText).toBe(CONTENT);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });

  test("renders while streaming even before any reasoning text arrives", () => {
    const { getByTestId } = render(
      <ThoughtProcessLink content="" isStreaming />,
    );
    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByTestId("thought-process-loading")).toBeTruthy();
  });

  test("renders nothing when content is empty and not streaming", () => {
    const { queryByTestId } = render(<ThoughtProcessLink content="" />);
    expect(queryByTestId("thought-process-link")).toBeNull();
  });
});
