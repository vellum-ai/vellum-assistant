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

import {
  PhaseGroupedStepList,
  phaseHeaderStatus,
  sumDurationLabels,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

afterEach(() => {
  cleanup();
});

function thinking(
  text: string,
  duration = "",
  timing?: { startedAt: number; completedAt: number },
): ToolCallCardStep {
  return { kind: "thinking", durationLabel: duration, text, ...timing };
}

function bash(
  command: string,
  status: "running" | "completed" | "error" | "denied" = "completed",
  duration = "",
  toolCallId = `tc-${command}`,
): ToolCallCardStep {
  return {
    kind: "tool",
    title: "Working",
    info: command,
    activity: "",
    iconName: "terminal",
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

  test("Thinking → Working → Thinking produces 3 distinct phase sections", () => {
    const steps: ToolCallCardStep[] = [
      thinking("First reasoning"),
      bash("ls -la", "completed", "1s", "tc-bash-1"),
      thinking("Second reasoning"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const sections = getAllByTestId("phase-section");
    expect(sections.length).toBe(3);
    expect(sections[0]!.getAttribute("data-phase-label")).toBe("Thinking");
    expect(sections[1]!.getAttribute("data-phase-label")).toBe("Working");
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

  test("phase with a tool_error step renders the completed icon (no error chrome)", () => {
    const steps: ToolCallCardStep[] = [
      { kind: "tool_error", message: "context window exceeded" },
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
  });

  test("phase with a tool step status='error' renders the completed icon (no error chrome)", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("rm -rf /nope", "error", "1s", "tc-b"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
  });

  test("phase with a tool step status='denied' renders the completed icon (no error chrome)", () => {
    const steps: ToolCallCardStep[] = [
      bash("sudo rm -rf /", "denied", "", "tc-a"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
  });

  test("phase with a failed step and a running step renders three-dot (running wins)", () => {
    const steps: ToolCallCardStep[] = [
      bash("rm -rf /nope", "error", "1s", "tc-a"),
      bash("sleep 5", "running", "", "tc-b"),
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    // Running takes precedence: no failed/completed data-status, three-dot
    // exposes 3 children.
    expect(icons[0]!.getAttribute("data-status")).toBeNull();
    expect(icons[0]!.children.length).toBe(3);
  });

  test("phase with an in-flight web_search step renders three-dot (not the green check)", () => {
    // `web_search` carries no explicit status field — its present-tense
    // title is the canonical in-flight signal. Without this branch the
    // header reads as completed while the search is still running.
    const steps: ToolCallCardStep[] = [
      {
        kind: "web_search",
        title: "Searching the web",
        durationLabel: "",
        linkCount: 0,
        results: [],
      },
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBeNull();
    expect(icons[0]!.children.length).toBe(3);
  });

  test("phase with only terminal web_search steps renders the green check", () => {
    const steps: ToolCallCardStep[] = [
      {
        kind: "web_search",
        title: "Searched the web",
        durationLabel: "1s",
        linkCount: 1,
        results: [],
      },
    ];
    const { getAllByTestId } = render(<PhaseGroupedStepList steps={steps} />);
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
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

describe("PhaseGroupedStepList — timeline mode", () => {
  test("keeps the phase-section / phase-header / phase-step-pill testids", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      thinking("Reasoning"),
    ];
    const { getAllByTestId } = render(
      <PhaseGroupedStepList steps={steps} timeline />,
    );
    expect(getAllByTestId("phase-section").length).toBe(2);
    expect(getAllByTestId("phase-header").length).toBe(2);
    // 1 bash pill (with info) + 1 thinking pill.
    expect(getAllByTestId("phase-step-pill").length).toBe(2);
  });

  test("completed section renders the circular CheckCircle2 node with data-status", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
    ];
    const { getAllByTestId } = render(
      <PhaseGroupedStepList steps={steps} timeline />,
    );
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
    // CheckCircle2 (lucide) renders an <svg> — distinct from the bare `Check`
    // glyph by the circle path it carries. Assert it's an SVG node and not the
    // three-dot indicator (which renders dot <span> children, not an svg).
    expect(icons[0]!.tagName.toLowerCase()).toBe("svg");
  });

  test("failed section renders the circular completed node (no error chrome)", () => {
    const steps: ToolCallCardStep[] = [
      { kind: "tool_error", message: "context window exceeded" },
    ];
    const { getAllByTestId } = render(
      <PhaseGroupedStepList steps={steps} timeline />,
    );
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons[0]!.getAttribute("data-status")).toBe("completed");
    expect(icons[0]!.tagName.toLowerCase()).toBe("svg");
  });

  test("running section keeps the three-dot indicator node", () => {
    const steps: ToolCallCardStep[] = [
      bash("sleep 5", "running", "", "tc-a"),
    ];
    const { getAllByTestId } = render(
      <PhaseGroupedStepList steps={steps} timeline />,
    );
    const icons = getAllByTestId("phase-header-status-icon");
    expect(icons[0]!.getAttribute("data-status")).toBeNull();
    expect(icons[0]!.children.length).toBe(3);
  });

  test("renders a gapped connector line for every non-last section, none for the last (no header lead-in)", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      thinking("Reasoning"),
      bash("pwd", "completed", "1s", "tc-b"),
    ];
    const { getAllByTestId } = render(
      <PhaseGroupedStepList steps={steps} timeline />,
    );
    const sections = getAllByTestId("phase-section");
    expect(sections.length).toBe(3);
    const connectorsIn = (section: Element) =>
      Array.from(
        section.querySelectorAll('div[aria-hidden][class*="w-px"]'),
      ) as HTMLElement[];

    // First section: only the inter-node segment (`top-6 bottom-0`). The
    // expanded card header omits its status icon, so there is no lead-in
    // trailing up to it — the timeline starts cleanly at the first node.
    expect(connectorsIn(sections[0]!).length).toBe(1);
    // Middle section: one inter-node segment.
    expect(connectorsIn(sections[1]!).length).toBe(1);
    // Last section: no line trails below the final circle.
    expect(connectorsIn(sections[2]!).length).toBe(0);

    // No section renders a `bottom-full` lead-in any more.
    expect(
      sections.some((s) =>
        connectorsIn(s).some((el) => el.className.includes("bottom-full")),
      ),
    ).toBe(false);

    // The inter-node segment starts below its node (`top-6`) and runs to the
    // section bottom (`bottom-0`) — a small, even gap before the next node.
    const interNode = (section: Element) =>
      connectorsIn(section).find((el) => el.className.includes("top-6"))!;
    expect(interNode(sections[1]!).className).toContain("top-6");
    expect(interNode(sections[1]!).className).toContain("bottom-0");
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

  test("a stamped thinking phase makes its duration a hover trigger", () => {
    /**
     * Thinking phases reuse the same duration tooltip as tool phases: when a
     * start time is known the duration becomes a `cursor-default` hover trigger
     * ("Started at …").
     */

    // GIVEN a thinking phase carrying start/completion timestamps
    const { getAllByTestId } = render(
      <PhaseGroupedStepList
        steps={[
          thinking("reasoning", "3s", { startedAt: 1_000, completedAt: 4_000 }),
        ]}
        timeline
      />,
    );

    // WHEN inspecting the phase header's duration
    const header = getAllByTestId("phase-header")[0]!;

    // THEN the duration is wrapped in the tooltip hover trigger
    expect(header.textContent).toContain("3s");
    expect(header.querySelector(".cursor-default")).not.toBeNull();
  });

  test("an unstamped thinking phase keeps its duration a plain label", () => {
    /**
     * Without a start time the duration stays a plain label — no hover trigger
     * — exactly as a tool phase with no timing behaves.
     */

    // GIVEN a thinking phase with a duration but no timestamps
    const { getAllByTestId } = render(
      <PhaseGroupedStepList steps={[thinking("reasoning", "3s")]} timeline />,
    );

    // WHEN inspecting the phase header's duration
    const header = getAllByTestId("phase-header")[0]!;

    // THEN the duration renders without the tooltip hover trigger
    expect(header.textContent).toContain("3s");
    expect(header.querySelector(".cursor-default")).toBeNull();
  });
});

describe("phaseHeaderStatus", () => {
  test("returns 'running' when any step is running (precedence over failure)", () => {
    const steps: ToolCallCardStep[] = [
      bash("rm -rf /nope", "error", "1s", "tc-a"),
      bash("sleep 5", "running", "", "tc-b"),
    ];
    expect(phaseHeaderStatus(steps)).toBe("running");
  });

  test("returns 'completed' when a step errored or was denied with none running", () => {
    expect(
      phaseHeaderStatus([bash("rm -rf /nope", "error", "1s", "tc-a")]),
    ).toBe("completed");
    expect(
      phaseHeaderStatus([bash("sudo rm -rf /", "denied", "", "tc-b")]),
    ).toBe("completed");
  });

  test("returns 'completed' otherwise", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];
    expect(phaseHeaderStatus(steps)).toBe("completed");
  });
});

describe("sumDurationLabels", () => {
  test("sums non-empty labels and re-formats the total", () => {
    expect(sumDurationLabels(["3s", "2s"])).toBe("5s");
  });

  test("returns an empty string for an empty or all-empty input", () => {
    expect(sumDurationLabels([])).toBe("");
    expect(sumDurationLabels(["", ""])).toBe("");
  });
});
