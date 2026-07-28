/**
 * Tests for `SubagentAvatarRow`.
 *
 * Drives the Zustand subagent store with spawned ids (a badge renders no
 * indicator until its entry lands in the store) and asserts the collapsed
 * summary caps visible avatars at `MAX_VISIBLE_SUBAGENT_AVATARS`, surfaces a
 * `+N` overflow chip past the cap, and fires `onExpand` from the Details
 * toggle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  MAX_VISIBLE_SUBAGENT_AVATARS,
  SubagentAvatarRow,
} from "@/domains/chat/components/subagent-inline-progress-card/subagent-avatar-row";
import { useSubagentStore } from "@/domains/chat/subagent-store";

const NOW = 1700000000000;

beforeEach(() => {
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

/** Spawn `count` subagents and return their ids so the badges render. */
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

describe("SubagentAvatarRow", () => {
  test("renders one badge per id and no overflow chip when at or below the cap", () => {
    const ids = spawnIds(MAX_VISIBLE_SUBAGENT_AVATARS);
    const { queryAllByTestId, queryByTestId } = render(
      <SubagentAvatarRow subagentIds={ids} onExpand={() => {}} />,
    );

    expect(queryAllByTestId("subagent-avatar-badge")).toHaveLength(
      MAX_VISIBLE_SUBAGENT_AVATARS,
    );
    expect(queryByTestId("subagent-avatar-row-overflow")).toBeNull();
  });

  test("caps badges at the max and shows a +N overflow chip past it", () => {
    const extra = 6;
    const ids = spawnIds(MAX_VISIBLE_SUBAGENT_AVATARS + extra);
    const { queryAllByTestId, getByTestId } = render(
      <SubagentAvatarRow subagentIds={ids} onExpand={() => {}} />,
    );

    expect(queryAllByTestId("subagent-avatar-badge")).toHaveLength(
      MAX_VISIBLE_SUBAGENT_AVATARS,
    );
    expect(getByTestId("subagent-avatar-row-overflow").textContent).toBe(
      `+${extra}`,
    );
  });

  test("clicking Details invokes onExpand", () => {
    const ids = spawnIds(2);
    let expanded = 0;
    const { getByTestId } = render(
      <SubagentAvatarRow subagentIds={ids} onExpand={() => (expanded += 1)} />,
    );

    fireEvent.click(getByTestId("subagent-avatar-row-details"));
    expect(expanded).toBe(1);
  });

  test("clicking an avatar badge invokes onExpand", () => {
    const ids = spawnIds(2);
    let expanded = 0;
    const { getAllByTestId } = render(
      <SubagentAvatarRow subagentIds={ids} onExpand={() => (expanded += 1)} />,
    );

    fireEvent.click(getAllByTestId("subagent-avatar-badge")[0]);
    expect(expanded).toBe(1);
  });
});
