/**
 * Tests for `SubagentSpawnGroup`.
 *
 * The group renders the SAME control as the floating status cluster: a pill of
 * stacked agent marks that opens the session list in a popover. So the rows are
 * not in the tree at rest. Opening the pill is what mounts them, which is also
 * what triggers their timeline fetches.
 *
 * Drives the Zustand subagent store with spawned ids, opens the control, and
 * asserts the rows and their handlers.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// Pin the platform to a pointer device, so the control opens its POPOVER and
// not the touch bottom sheet. Unmocked, `matchMedia` in the test DOM does not
// answer either query the way a real browser would.
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));
mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => false,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

const { SubagentSpawnGroup } = await import(
  "@/domains/chat/components/subagent-inline-progress-card/subagent-spawn-group"
);
const { useSubagentStore } = await import("@/domains/chat/subagent-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

const NOW = 1700000000000;

beforeEach(() => {
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

/**
 * Open the group's control so its session rows mount. The popover portals its
 * content to the body, so everything past this point is queried through
 * `screen` rather than the render container.
 */
function openControl() {
  fireEvent.click(screen.getByTestId("subagent-spawn-group-trigger"));
}

/** The rows are the agents panel's own, so they carry its per-id testids. */
function rows(): HTMLElement[] {
  return screen.queryAllByTestId(/^progress-agent-/);
}

/** Spawn `count` subagents and return their ids so the marks/rows render. */
function spawnIds(count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `sa-${i}`);
  for (const id of ids) {
    useSubagentStore.getState().spawnSubagent({
      subagentId: id,
      label: "Research Agent",
      objective: "Find the answer",
      timestamp: NOW,
    });
  }
  return ids;
}

describe("SubagentSpawnGroup", () => {
  test("renders null for an empty id set", () => {
    const { container } = render(<SubagentSpawnGroup subagentIds={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("rests as the marks control, and opens to one row per spawn", () => {
    const ids = spawnIds(3);
    render(<SubagentSpawnGroup subagentIds={ids} />);

    // At rest it is the same pill the floating cluster shows: the marks, no
    // rows, and none of the old bespoke disclosure chrome.
    expect(screen.getByTestId("subagent-spawn-group-trigger")).toBeTruthy();
    expect(rows()).toHaveLength(0);
    expect(screen.queryAllByTestId("subagent-avatar-badge")).toHaveLength(0);
    expect(
      screen.queryAllByTestId("subagent-avatar-row-details"),
    ).toHaveLength(0);

    openControl();
    expect(rows()).toHaveLength(3);
  });

  test("rows demand their missing timelines once opened", () => {
    // Terminal + addressable entries with no events: exactly the state whose
    // card projects "Loading" until its timeline is fetched. The demand lives
    // in `useSubagentCardData` (rendering a row IS the fetch trigger), so the
    // closed control fetches nothing and opening it fetches every member.
    useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");
    const ids = ["sa-done-0", "sa-done-1"];
    for (const id of ids) {
      useSubagentStore.getState().spawnSubagent({
        subagentId: id,
        label: "Research Agent",
        objective: "",
        status: "completed",
        conversationId: `conv-${id}`,
        timestamp: NOW,
      });
    }
    const spy = spyOn(
      useSubagentStore.getState(),
      "fetchDetailIfNeeded",
    ).mockImplementation(async () => {});

    render(<SubagentSpawnGroup subagentIds={ids} />);

    // Closed: the rows are not mounted, so nothing has been demanded yet.
    expect(spy).not.toHaveBeenCalled();

    openControl();
    expect(rows()).toHaveLength(2);
    expect(spy).toHaveBeenCalledWith("assistant-1", "sa-done-0");
    expect(spy).toHaveBeenCalledWith("assistant-1", "sa-done-1");

    spy.mockRestore();
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  });

  test("threads onSubagentClick and onStopSubagent to each row", () => {
    const ids = spawnIds(2);
    // Mark in-flight so the stop button renders on the rows.
    for (const id of ids) {
      useSubagentStore
        .getState()
        .changeStatus({ subagentId: id, status: "running" });
    }

    const clicked: string[] = [];
    const stopped: string[] = [];
    render(
      <SubagentSpawnGroup
        subagentIds={ids}
        onSubagentClick={(id) => clicked.push(id)}
        onStopSubagent={(id) => stopped.push(id)}
      />,
    );

    openControl();
    const openedRows = rows();
    // The open affordance lives on the leading cluster (a `role="button"`
    // element inside the row), not on the row container itself, so the stop
    // button is not nested inside it. Click the affordance, not the row.
    fireEvent.click(
      within(openedRows[0]!).getByRole("button", { name: /open subagent/i }),
    );
    expect(clicked).toEqual([ids[0]]);

    // Opening a row closes the panel, so the stop button needs it reopened.
    openControl();
    const stopButtons = screen.getAllByTestId("inline-process-card-stop");
    fireEvent.click(stopButtons[1]);
    expect(stopped).toEqual([ids[1]]);
  });
});
