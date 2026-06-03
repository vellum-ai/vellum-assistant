/**
 * Tests for `TurnProgressCard`.
 *
 * Uses `@testing-library/react` + `bun:test` (matching the interactive web
 * tests, e.g. `tool-step-pill.test.tsx`). The expanded body renders the step
 * pills, so the pill-oriented tests pass `defaultExpanded` to surface them.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { TurnProgressCard } from "@/domains/chat/components/turn-progress-card/turn-progress-card";
import type {
  ActivityStep,
  TurnActivity,
} from "@/domains/chat/transcript/turn-activity";

afterEach(() => {
  cleanup();
});

function step(overrides: Partial<ActivityStep> = {}): ActivityStep {
  return {
    anchorId: "anchor-1",
    kind: "tool",
    title: "Working (bash)",
    info: "bun test",
    state: "complete",
    iconName: "code",
    ...overrides,
  };
}

function activity(overrides: Partial<TurnActivity> = {}): TurnActivity {
  const steps = overrides.steps ?? [step()];
  const last = steps[steps.length - 1];
  return {
    steps,
    currentStepTitle: last?.title ?? "",
    currentStepInfo: last?.info ?? "",
    state: "complete",
    stepCount: steps.length,
    ...overrides,
  };
}

describe("TurnProgressCard", () => {
  test("renders null for zero steps", () => {
    const { container } = render(
      <TurnProgressCard
        activity={activity({ steps: [], stepCount: 0 })}
        onStepClick={() => {}}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("renders one pill per step with the step titles", () => {
    const steps = [
      step({ anchorId: "a", title: "Thought process", kind: "thinking" }),
      step({ anchorId: "b", title: "Working (bash)" }),
      step({ anchorId: "c", title: "Editing", iconName: "pen" }),
    ];
    const { getAllByTestId } = render(
      <TurnProgressCard
        activity={activity({ steps })}
        onStepClick={() => {}}
        defaultExpanded
      />,
    );
    const pills = getAllByTestId("turn-progress-pill");
    expect(pills).toHaveLength(3);
    expect(pills.map((p) => p.getAttribute("data-anchor-id"))).toEqual([
      "a",
      "b",
      "c",
    ]);
    const text = pills.map((p) => p.textContent);
    expect(text[0]).toContain("Thought process");
    expect(text[1]).toContain("Working (bash)");
    expect(text[2]).toContain("Editing");
  });

  test("clicking a pill emits onStepClick with that step's anchorId", () => {
    const clicked: string[] = [];
    const steps = [
      step({ anchorId: "first", title: "Reading", iconName: "file" }),
      step({ anchorId: "second", title: "Editing", iconName: "pen" }),
    ];
    const { getAllByTestId } = render(
      <TurnProgressCard
        activity={activity({ steps })}
        onStepClick={(id) => clicked.push(id)}
        defaultExpanded
      />,
    );
    const pills = getAllByTestId("turn-progress-pill");
    fireEvent.click(pills[1]!.querySelector("button")!);
    expect(clicked).toEqual(["second"]);
  });

  test("header reflects currentStepTitle and shows the step-count pill", () => {
    const steps = [
      step({ anchorId: "a", title: "Reading" }),
      step({ anchorId: "b", title: "Editing" }),
    ];
    const { getByTestId, container } = render(
      <TurnProgressCard
        activity={activity({
          steps,
          currentStepTitle: "Editing",
          stepCount: 2,
        })}
        onStepClick={() => {}}
      />,
    );
    expect(container.textContent).toContain("Editing");
    expect(getByTestId("tool-progress-card-step-count-pill").textContent).toBe(
      "2 steps",
    );
  });

  test("loading state renders the status indicator", () => {
    const { getByTestId } = render(
      <TurnProgressCard
        activity={activity({
          steps: [step({ state: "loading" })],
          state: "loading",
        })}
        onStepClick={() => {}}
      />,
    );
    expect(
      getByTestId("tool-progress-card-status-indicator"),
    ).toBeDefined();
  });

  test("attachedBelow wraps the card to drop bottom rounding", () => {
    const { container } = render(
      <TurnProgressCard
        activity={activity()}
        onStepClick={() => {}}
        attachedBelow
      />,
    );
    expect(
      container.querySelector(".\\[\\&\\>\\*\\]\\:rounded-b-none"),
    ).not.toBeNull();
  });
});
