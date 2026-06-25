/**
 * Tests for `ActiveSubagentsOverlay`.
 *
 * Seeds the Zustand subagent store with `running` entries for each id (the
 * reused `SubagentInlineProgressCard` reads the store), then asserts the
 * empty/collapsed/expanded states, the "+N" overflow, the per-row stop/open
 * callbacks, and Escape / outside-click dismissal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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
    const title = getByText("3 Active Subagents");
    expect(title).toBeTruthy();
    expect(getAllByTestId("subagent-inline-progress-card").length).toBe(3);

    // Panel is an absolutely-positioned dropdown so its width can't stretch the
    // row when a sibling overlay pill is present (regression guard).
    const panel = title.parentElement;
    expect(panel?.className).toContain("absolute");
    expect(panel?.className).toContain("pointer-events-auto");

    // Width is driven by the measured-column fallback (happy-dom has no layout),
    // so it must resolve to a finite, positive px value — not 0 or NaN.
    const fittedWidth = Number.parseFloat(panel?.style.width ?? "");
    expect(Number.isFinite(fittedWidth)).toBe(true);
    expect(fittedWidth).toBeGreaterThan(0);
  });

  test("clicking a collapsed avatar expands the panel", () => {
    const ids = seedMany(3);
    render(<ActiveSubagentsOverlay subagentIds={ids} />);

    const pill = screen.getByRole("button", { name: /active subagents/i });
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getAllByLabelText(/^Subagent /)[0]);

    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("3 Active Subagents")).toBeTruthy();
  });

  test("uses the singular noun when exactly one subagent is active", () => {
    const ids = seedMany(1);
    render(<ActiveSubagentsOverlay subagentIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));

    expect(screen.getByText("1 Active Subagent")).toBeTruthy();
    expect(screen.queryByText("1 Active Subagents")).toBeNull();
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

describe("ActiveSubagentsOverlay — drill-in", () => {
  test("opening a row fires onSubagentClick and closes the dropdown", async () => {
    const ids = seedMany(2);
    const opened: string[] = [];
    const { queryByText } = render(
      <ActiveSubagentsOverlay
        subagentIds={ids}
        onSubagentClick={(id) => opened.push(id)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));
    expect(queryByText("2 Active Subagents")).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("button", { name: /open subagent/i })[0],
    );

    // The detail panel still opens (existing behavior).
    expect(opened).toEqual(["sa-0"]);
    // ...and the dropdown then closes so the two layers stop competing. It
    // animates out via AnimatePresence (~1.8s in happy-dom), so wait it out.
    await waitFor(
      () => expect(queryByText("2 Active Subagents")).toBeNull(),
      { timeout: 4000 },
    );
  });

  test("stopping a row does NOT close the dropdown", () => {
    const ids = seedMany(2);
    const stopped: string[] = [];
    const { queryByText } = render(
      <ActiveSubagentsOverlay
        subagentIds={ids}
        onStopSubagent={(id) => stopped.push(id)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));
    fireEvent.click(screen.getAllByTestId("subagent-inline-card-stop")[0]);

    expect(stopped).toEqual(["sa-0"]);
    // Stopping keeps the list open so you can stop another / keep watching.
    expect(queryByText("2 Active Subagents")).toBeTruthy();
  });
});

describe("ActiveSubagentsOverlay — dismissal", () => {
  test("Escape collapses the open panel", async () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveSubagentsOverlay subagentIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));
    expect(queryByText("2 Active Subagents")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    // The dropdown animates out via AnimatePresence, so it lingers for the
    // exit animation before unmounting.
    await waitFor(
      () => expect(queryByText("2 Active Subagents")).toBeNull(),
      { timeout: 4000 },
    );
  });

  test("pointerdown outside the container collapses the open panel", async () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveSubagentsOverlay subagentIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active subagents/i }));
    expect(queryByText("2 Active Subagents")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(
      () => expect(queryByText("2 Active Subagents")).toBeNull(),
      { timeout: 4000 },
    );
  });
});
