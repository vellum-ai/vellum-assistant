/**
 * Tests for `ActiveSubagentsOverlay`.
 *
 * Seeds the Zustand subagent store with `running` entries for each id (the
 * reused `SubagentInlineProgressCard` reads the store), then asserts the
 * empty/collapsed/expanded states, the "+N" overflow, the per-row stop/open
 * callbacks, and Escape / outside-click dismissal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ActiveSubagentsOverlay } from "@/domains/chat/components/active-subagents-overlay/active-subagents-overlay";
import { useSubagentStore } from "@/domains/chat/subagent-store";

const NOW = 1700000000000;

beforeEach(() => {
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

function seed(id: string) {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label: "Research Agent",
    objective: "Find the answer",
    timestamp: NOW,
  });
  useSubagentStore.getState().changeStatus({ subagentId: id, status: "running" });
}

function seedMany(count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `sa-${i}`);
  ids.forEach(seed);
  return ids;
}

describe("ActiveSubagentsOverlay — empty", () => {
  test("renders nothing when subagentIds is empty", () => {
    const { queryByTestId } = render(
      <ActiveSubagentsOverlay subagentIds={[]} />,
    );
    expect(queryByTestId("active-subagents-overlay")).toBeNull();
  });
});

describe("ActiveSubagentsOverlay — collapsed", () => {
  test("shows the pill, hides the panel, and renders +N overflow for >6 ids", () => {
    const ids = seedMany(8);
    const { queryByText } = render(<ActiveSubagentsOverlay subagentIds={ids} />);

    const pill = screen.getByRole("button", { name: /active subagents/i });
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    // 8 ids, 6 visible avatars → "+2" overflow.
    expect(queryByText("+2")).toBeTruthy();
    expect(queryByText("8 Active Subagents")).toBeNull();
  });

  test("root is pointer-events-none so the gutter doesn't block the transcript", () => {
    const ids = seedMany(2);
    render(<ActiveSubagentsOverlay subagentIds={ids} />);
    expect(
      screen.getByTestId("active-subagents-overlay").className,
    ).toContain("pointer-events-none");
  });
});

describe("ActiveSubagentsOverlay — expanded", () => {
  test("clicking the pill reveals the panel with the title and one row per id", () => {
    const ids = seedMany(3);
    const { getByText, getAllByTestId } = render(
      <ActiveSubagentsOverlay subagentIds={ids} />,
    );

    const pill = screen.getByRole("button", { name: /active subagents/i });
    fireEvent.click(pill);

    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("3 Active Subagents")).toBeTruthy();
    expect(getAllByTestId("subagent-inline-progress-card").length).toBe(3);
  });

  test("per-row stop invokes onStopSubagent and per-row open invokes onSubagentClick", () => {
    const ids = seedMany(2);
    const stopped: string[] = [];
    const opened: string[] = [];
    const { getAllByTestId, getAllByRole } = render(
      <ActiveSubagentsOverlay
        subagentIds={ids}
        onSubagentClick={(id) => opened.push(id)}
        onStopSubagent={(id) => stopped.push(id)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));

    fireEvent.click(getAllByTestId("subagent-inline-card-stop")[0]);
    expect(stopped).toEqual(["sa-0"]);

    fireEvent.click(getAllByRole("button", { name: /open subagent/i })[1]);
    expect(opened).toEqual(["sa-1"]);
  });
});

describe("ActiveSubagentsOverlay — dismissal", () => {
  test("Escape collapses the open panel", () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveSubagentsOverlay subagentIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));
    expect(queryByText("2 Active Subagents")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByText("2 Active Subagents")).toBeNull();
  });

  test("pointerdown outside the container collapses the open panel", () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveSubagentsOverlay subagentIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));
    expect(queryByText("2 Active Subagents")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(queryByText("2 Active Subagents")).toBeNull();
  });
});
