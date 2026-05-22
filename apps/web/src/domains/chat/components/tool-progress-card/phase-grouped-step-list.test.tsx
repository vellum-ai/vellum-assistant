/**
 * Tests for `PhaseGroupedStepList`.
 *
 * The list is pure presentational — assertions cover the grouping logic
 * (contiguous same-phase collapse, no cross-section merging), the phase
 * header status icon (all-completed check vs animated indicator), the
 * `renderStep` override path, and the empty-input contract.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { PhaseGroupedStepList } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list.js";
import type { ToolCallCardStep } from "@/domains/chat/hooks/use-tool-call-card-data.js";

afterEach(() => {
  cleanup();
});

function thinking(text: string, duration = ""): ToolCallCardStep {
  return { kind: "thinking", durationLabel: duration, text };
}

function bash(
  command: string,
  status: "running" | "completed" | "error" | "denied" = "completed",
  duration = "",
  toolCallId = `tc-${command}`,
): ToolCallCardStep {
  return {
    kind: "tool",
    title: "Working (bash)",
    info: command,
    iconName: "code",
    durationLabel: duration,
    toolCallId,
    status,
  };
}

describe("PhaseGroupedStepList — empty input", () => {
  test("renders nothing when there are no steps", () => {
    const { container } = render(<PhaseGroupedStepList steps={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("PhaseGroupedStepList — phase grouping", () => {
  test("two consecutive Thinking steps collapse into one phase with two pills", () => {
    const steps: ToolCallCardStep[] = [
      thinking("Forming a query"),
      thinking("Picking sources"),
    ];
    const { getAllByTestId, getByText } = render(
      <PhaseGroupedStepList steps={steps} />,
    );
    const sections = getAllByTestId("phase-section");
    expect(sections.length).toBe(1);
    expect(sections[0]!.getAttribute("data-phase-label")).toBe("Thinking");
    // Both pills appear inside the single section.
    expect(getByText("Forming a query")).toBeTruthy();
    expect(getByText("Picking sources")).toBeTruthy();
    const pills = getAllByTestId("phase-step-pill");
    expect(pills.length).toBe(2);
  });

  test("Thinking → Working (bash) → Thinking produces 3 distinct phase sections", () => {
    const steps: ToolCallCardStep[] = [
      thinking("First reasoning"),
      bash("ls -la", "completed", "1s", "tc-bash-1"),
      thinking("Second reasoning"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const sections = getAllByTestId("phase-section");
    expect(sections.length).toBe(3);
    expect(sections[0]!.getAttribute("data-phase-label")).toBe("Thinking");
    expect(sections[1]!.getAttribute("data-phase-label")).toBe(
      "Working (bash)",
    );
    expect(sections[2]!.getAttribute("data-phase-label")).toBe("Thinking");
  });
});

describe("PhaseGroupedStepList — phase header status icon", () => {
  test("all-completed section renders a green check", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
  });

  test("mixed-status section renders the animated three-dot indicator", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("sleep 5", "running", "", "tc-b"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    // The three-dot indicator does not stamp the `data-status` attribute the
    // completed-check uses — its absence is the regression contract.
    expect(icons[0]!.getAttribute("data-status")).toBeNull();
    // It exposes 3 dot children (matches `ThreeDotIndicator`'s contract).
    expect(icons[0]!.children.length).toBe(3);
  });
});

describe("PhaseGroupedStepList — renderStep override", () => {
  test("calls renderStep for each step and skips the default pill", () => {
    const steps: ToolCallCardStep[] = [
      thinking("First"),
      thinking("Second"),
    ];
    const seen: string[] = [];
    const { queryAllByTestId, getByText } = render(
      <PhaseGroupedStepList
        steps={steps}
        renderStep={(step) => {
          if (step.kind === "thinking") {
            seen.push(step.text);
            return <div data-testid="custom-step">{step.text}</div>;
          }
          return null;
        }}
      />,
    );
    expect(seen).toEqual(["First", "Second"]);
    // No default pills were rendered.
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);
    // Custom nodes are present.
    expect(getByText("First")).toBeTruthy();
    expect(getByText("Second")).toBeTruthy();
  });
});

describe("PhaseGroupedStepList — phase header total duration", () => {
  test("sums step durations across the section", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const header = getAllByTestId("phase-header")[0]!;
    expect(header.textContent).toContain("3s");
  });
});
