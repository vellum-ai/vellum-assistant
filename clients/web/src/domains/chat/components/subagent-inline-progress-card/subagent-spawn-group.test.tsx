/**
 * Tests for `SubagentSpawnGroup`.
 *
 * Drives the Zustand subagent store with spawned ids so badges/rows render,
 * then asserts the collapse/expand contract: the resting state is the compact
 * `SubagentAvatarRow` summary (badges present, list rows absent); "Details"
 * expands into the generic `InlineProcessCard` list (testid `inline-process-card`)
 * plus a "Collapse" toggle; and "Collapse" returns to the summary.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { SubagentSpawnGroup } from "@/domains/chat/components/subagent-inline-progress-card/subagent-spawn-group";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const NOW = 1700000000000;

beforeEach(() => {
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

/** Spawn `count` subagents and return their ids so badges/rows render. */
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

  test("defaults to the collapsed avatar summary (no list rows)", () => {
    const ids = spawnIds(3);
    const { queryAllByTestId } = render(
      <SubagentSpawnGroup subagentIds={ids} />,
    );

    // Badges present, but the expanded list rows are not yet rendered.
    expect(queryAllByTestId("subagent-avatar-badge")).toHaveLength(3);
    expect(queryAllByTestId("inline-process-card")).toHaveLength(0);
  });

  test("expanded rows demand their missing timelines; the collapsed summary demands nothing", async () => {
    // Terminal + addressable entries with no events: exactly the state whose
    // card projects "Loading" until its timeline is fetched. The demand lives
    // in `useSubagentCardData` (rendering a row IS the fetch trigger), so
    // expanding must fetch each member and the resting summary must not.
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

    const { getByTestId, findAllByTestId } = render(
      <SubagentSpawnGroup subagentIds={ids} />,
    );
    // Collapsed avatar summary mounts no card data, so nothing fetches on load.
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("subagent-avatar-row-details"));

    // The expand still happens; the fetch is a side-effect, not a gate.
    expect(await findAllByTestId("inline-process-card")).toHaveLength(2);
    expect(spy).toHaveBeenCalledWith("assistant-1", "sa-done-0");
    expect(spy).toHaveBeenCalledWith("assistant-1", "sa-done-1");

    spy.mockRestore();
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  });

  test("Details expands to the row list plus a Collapse toggle", async () => {
    const ids = spawnIds(3);
    const { getByTestId, findAllByTestId, queryAllByTestId } = render(
      <SubagentSpawnGroup subagentIds={ids} />,
    );

    fireEvent.click(getByTestId("subagent-avatar-row-details"));

    // The crossfade defers the incoming view (AnimatePresence mode="wait"),
    // so wait for the inline cards to mount.
    expect(await findAllByTestId("inline-process-card")).toHaveLength(3);
    expect(queryAllByTestId("subagent-avatar-badge")).toHaveLength(0);
    expect(getByTestId("subagent-spawn-group-collapse")).toBeTruthy();
  });

  test("Collapse returns to the avatar summary", async () => {
    const ids = spawnIds(3);
    const {
      getByTestId,
      findByTestId,
      findAllByTestId,
      queryAllByTestId,
      queryByTestId,
    } = render(<SubagentSpawnGroup subagentIds={ids} />);

    fireEvent.click(getByTestId("subagent-avatar-row-details"));
    fireEvent.click(await findByTestId("subagent-spawn-group-collapse"));

    expect(await findAllByTestId("subagent-avatar-badge")).toHaveLength(3);
    expect(queryAllByTestId("inline-process-card")).toHaveLength(0);
    expect(queryByTestId("subagent-spawn-group-collapse")).toBeNull();
  });

  test("threads onSubagentClick and onStopSubagent to each expanded row", async () => {
    const ids = spawnIds(2);
    // Mark in-flight so the stop button renders on the rows.
    for (const id of ids) {
      useSubagentStore
        .getState()
        .changeStatus({ subagentId: id, status: "running" });
    }

    const clicked: string[] = [];
    const stopped: string[] = [];
    const { getByTestId, getAllByTestId, findAllByTestId } = render(
      <SubagentSpawnGroup
        subagentIds={ids}
        onSubagentClick={(id) => clicked.push(id)}
        onStopSubagent={(id) => stopped.push(id)}
      />,
    );

    fireEvent.click(getByTestId("subagent-avatar-row-details"));

    const rows = await findAllByTestId("inline-process-card");
    // The open affordance lives on the leading cluster (a `role="button"`
    // element inside the row), not on the row container itself, so the stop
    // button is not nested inside it. Click the affordance, not the row.
    fireEvent.click(
      within(rows[0]).getByRole("button", { name: /open subagent/i }),
    );
    expect(clicked).toEqual([ids[0]]);

    const stopButtons = getAllByTestId("inline-process-card-stop");
    fireEvent.click(stopButtons[1]);
    expect(stopped).toEqual([ids[1]]);
  });
});
