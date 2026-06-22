/**
 * Tests for `SubagentPhaseTimeline`.
 *
 * The timeline is pure presentational. Assertions cover: a completed row's
 * label + "Worked for <dur>" summary with its step pills hidden until clicked
 * (and re-hidden on toggle back); a running row's `ThreeDotIndicator` node plus
 * the Brain + live-activity sub-label sourced from the running tool step's
 * `activity`; the conditional "N steps" pill (present for >= 2 steps, absent
 * for 1); and contiguous same-phase collapsing into a single row.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { SubagentPhaseTimeline } from "@/domains/chat/components/subagent-phase-timeline";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

afterEach(() => {
  cleanup();
});

function bash(
  command: string,
  status: "running" | "completed" | "error" | "denied" = "completed",
  duration = "",
  toolCallId = `tc-${command}`,
  activity = "",
): ToolCallCardStep {
  return {
    kind: "tool",
    title: "Working",
    info: command,
    activity,
    iconName: "code",
    durationLabel: duration,
    toolCallId,
    status,
  };
}

describe("SubagentPhaseTimeline — empty input", () => {
  test("renders nothing when there are no steps (panel owns the empty state)", () => {
    const { container } = render(<SubagentPhaseTimeline steps={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SubagentPhaseTimeline — completed row", () => {
  test("shows label + 'Worked for <dur>', hides pills by default, toggles on click", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];
    const { getAllByTestId, getByTestId, queryAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    // One row for the single "Working" phase.
    const sections = getAllByTestId("subagent-phase-section");
    expect(sections.length).toBe(1);

    const header = getByTestId("subagent-phase-header");
    expect(header.textContent).toContain("Working");
    // 1s + 2s summed and re-formatted.
    expect(header.textContent).toContain("Worked for 3s");

    // Collapsed by default — no step pills.
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);

    // Click reveals the pills.
    fireEvent.click(header);
    expect(queryAllByTestId("phase-step-pill").length).toBe(2);

    // Toggling back hides them.
    fireEvent.click(header);
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);
  });
});

describe("SubagentPhaseTimeline — running row", () => {
  test("renders the ThreeDotIndicator node and a Brain + live activity sub-label", () => {
    const steps: ToolCallCardStep[] = [
      bash("sleep 5", "running", "", "tc-a", "Compiling the project"),
    ];
    const { getByTestId } = render(<SubagentPhaseTimeline steps={steps} />);

    // The running node is the three-dot indicator: it stamps no `data-status`
    // and exposes 3 dot children (the `ThreeDotIndicator` contract).
    const node = getByTestId("phase-header-status-icon");
    expect(node.getAttribute("data-status")).toBeNull();
    expect(node.children.length).toBe(3);

    // The sub-label is sourced from the running tool step's `activity`.
    const header = getByTestId("subagent-phase-header");
    expect(header.textContent).toContain("Compiling the project");
  });

  test("falls back to the running step's info when activity is empty", () => {
    const steps: ToolCallCardStep[] = [
      bash("npm run build", "running", "", "tc-a", ""),
    ];
    const { getByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    const header = getByTestId("subagent-phase-header");
    expect(header.textContent).toContain("npm run build");
  });
});

describe("SubagentPhaseTimeline — step-count pill", () => {
  test("renders the 'N steps' pill for a 3-step phase", () => {
    const steps: ToolCallCardStep[] = [
      bash("a", "completed", "1s", "tc-a"),
      bash("b", "completed", "1s", "tc-b"),
      bash("c", "completed", "1s", "tc-c"),
    ];
    const { getByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    expect(getByTestId("subagent-phase-step-count").textContent).toBe(
      "3 steps",
    );
  });

  test("omits the step-count pill for a 1-step phase", () => {
    const steps: ToolCallCardStep[] = [bash("a", "completed", "1s", "tc-a")];
    const { queryByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    expect(queryByTestId("subagent-phase-step-count")).toBeNull();
  });
});

describe("SubagentPhaseTimeline — phase grouping", () => {
  test("contiguous same-phase steps collapse into one row", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "1s", "tc-b"),
      bash("cat x", "completed", "1s", "tc-c"),
    ];
    const { getAllByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    const sections = getAllByTestId("subagent-phase-section");
    expect(sections.length).toBe(1);
    expect(sections[0]!.getAttribute("data-phase-label")).toBe("Working");
  });
});
