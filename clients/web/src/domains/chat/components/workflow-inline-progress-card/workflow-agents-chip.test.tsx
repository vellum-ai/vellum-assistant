/**
 * Tests for `WorkflowAgentsChip`.
 *
 * `SubagentAvatarChip` lazily loads a ~48 kB bundled-avatar payload, so it is
 * mocked to a testid stub here to keep the test focused on the chip's own
 * structure: one avatar per seed, the count text, and the count-only path.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

mock.module("@/components/avatar/subagent-avatar-chip", () => ({
  SubagentAvatarChip: ({ subagentId }: { subagentId: string }) => (
    <span data-testid="avatar-stub" data-subagent-id={subagentId} />
  ),
}));

import { WorkflowAgentsChip } from "@/domains/chat/components/workflow-inline-progress-card/workflow-agents-chip";

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

describe("WorkflowAgentsChip", () => {
  test("renders the pill, one avatar per seed, and the count text", () => {
    const { getByTestId, getAllByTestId } = render(
      <WorkflowAgentsChip countLabel="3 agents" seeds={["a", "b", "c"]} />,
    );

    expect(getByTestId("workflow-inline-card-agents-chip")).toBeTruthy();
    expect(getAllByTestId("avatar-stub").length).toBe(3);
    expect(getByTestId("workflow-inline-card-step-count").textContent).toBe(
      "3 agents",
    );
  });

  test("renders count-only with no avatar stack when seeds is empty", () => {
    const { getByTestId, queryAllByTestId } = render(
      <WorkflowAgentsChip countLabel="1 agent" seeds={[]} />,
    );

    expect(getByTestId("workflow-inline-card-agents-chip")).toBeTruthy();
    expect(queryAllByTestId("avatar-stub").length).toBe(0);
    expect(getByTestId("workflow-inline-card-step-count").textContent).toBe(
      "1 agent",
    );
  });
});
