/**
 * Tests for `ActiveWorkflowsOverlay`.
 *
 * `WorkflowInlineProgressCard` renders `null` until its store entry exists
 * (spawn race), so it is mocked to a testid stub here to keep the overlay test
 * focused on the overlay's own empty/collapsed/expanded states and the
 * Escape / outside-click dismissal — not workflow-store hydration.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

mock.module(
  "@/domains/chat/components/workflow-inline-progress-card/workflow-inline-progress-card",
  () => ({
    WorkflowInlineProgressCard: ({ runId }: { runId: string }) => (
      <div data-testid="wf-card" data-run-id={runId} />
    ),
  }),
);

import { ActiveWorkflowsOverlay } from "@/domains/chat/components/active-workflows-overlay/active-workflows-overlay";

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `wf-${i}`);
}

describe("ActiveWorkflowsOverlay — empty", () => {
  test("renders nothing when workflowRunIds is empty", () => {
    const { queryByTestId } = render(
      <ActiveWorkflowsOverlay workflowRunIds={[]} />,
    );
    expect(queryByTestId("active-workflows-overlay")).toBeNull();
  });
});

describe("ActiveWorkflowsOverlay — collapsed", () => {
  test("shows the pill with the count and hides the panel", () => {
    const ids = makeIds(3);
    const { queryByText, queryAllByTestId } = render(
      <ActiveWorkflowsOverlay workflowRunIds={ids} />,
    );

    const pill = screen.getByRole("button", { name: /active workflows/i });
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    // Count is rendered in the pill.
    expect(queryByText("3")).toBeTruthy();
    // Panel is collapsed: no title, no cards.
    expect(queryByText("3 Active Workflows")).toBeNull();
    expect(queryAllByTestId("wf-card").length).toBe(0);
  });

  test("root is pointer-events-none so the gutter doesn't block the transcript", () => {
    const ids = makeIds(2);
    render(<ActiveWorkflowsOverlay workflowRunIds={ids} />);
    expect(
      screen.getByTestId("active-workflows-overlay").className,
    ).toContain("pointer-events-none");
  });
});

describe("ActiveWorkflowsOverlay — expanded", () => {
  test("clicking the pill reveals the panel with the title and one card per id", () => {
    const ids = makeIds(3);
    const { getByText, getAllByTestId } = render(
      <ActiveWorkflowsOverlay workflowRunIds={ids} />,
    );

    const pill = screen.getByRole("button", { name: /active workflows/i });
    fireEvent.click(pill);

    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const title = getByText("3 Active Workflows");
    expect(title).toBeTruthy();
    expect(getAllByTestId("wf-card").length).toBe(3);

    // Panel is an absolutely-positioned dropdown so its width can't stretch the
    // row when a sibling overlay pill is present (regression guard).
    const panel = title.parentElement;
    expect(panel?.className).toContain("absolute");
    expect(panel?.className).toContain("pointer-events-auto");
  });

  test("uses the singular noun when exactly one workflow is active", () => {
    const ids = makeIds(1);
    render(<ActiveWorkflowsOverlay workflowRunIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active workflow/i }));

    expect(screen.getByText("1 Active Workflow")).toBeTruthy();
    expect(screen.queryByText("1 Active Workflows")).toBeNull();
  });
});

describe("ActiveWorkflowsOverlay — dismissal", () => {
  test("Escape collapses the open panel", async () => {
    const ids = makeIds(2);
    const { queryByText } = render(
      <ActiveWorkflowsOverlay workflowRunIds={ids} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active workflows/i }));
    expect(queryByText("2 Active Workflows")).toBeTruthy();

    // Escape collapses the dropdown AND claims the event (preventDefault), so a
    // single Escape doesn't also close an underlying side panel —
    // ChatContentLayout's window keydown handler bails on defaultPrevented.
    // fireEvent returns false when the event was canceled.
    const notCanceled = fireEvent.keyDown(document, { key: "Escape" });
    expect(notCanceled).toBe(false);
    // The dropdown animates out via AnimatePresence, so it lingers for the
    // exit animation before unmounting.
    await waitFor(
      () => expect(queryByText("2 Active Workflows")).toBeNull(),
      { timeout: 4000 },
    );
  });

  test("pointerdown outside the container collapses the open panel", async () => {
    const ids = makeIds(2);
    const { queryByText } = render(
      <ActiveWorkflowsOverlay workflowRunIds={ids} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active workflows/i }));
    expect(queryByText("2 Active Workflows")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(
      () => expect(queryByText("2 Active Workflows")).toBeNull(),
      { timeout: 4000 },
    );
  });
});
