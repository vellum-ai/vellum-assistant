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

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { useState } from "react";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as phaseGroupedStepList from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
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
    iconName: "terminal",
    durationLabel: duration,
    toolCallId,
    status,
  };
}

function thinking(
  text: string,
  duration = "1s",
  detailKey?: string,
): ToolCallCardStep {
  return { kind: "thinking", durationLabel: duration, text, detailKey };
}

function toolError(message: string): ToolCallCardStep {
  return { kind: "tool_error", message };
}

function webSearch(
  results: Array<{ title: string; url: string; domain: string }>,
  title = "Searched the web",
  query?: string,
  detailKey?: string,
): ToolCallCardStep {
  return {
    kind: "web_search",
    title,
    query,
    durationLabel: "",
    linkCount: results.length,
    results: results.map((r, i) => ({ rank: i + 1, ...r })),
    detailKey,
  };
}

describe("SubagentPhaseTimeline — empty input", () => {
  test("renders nothing when there are no steps (panel owns the empty state)", () => {
    const { container } = render(<SubagentPhaseTimeline steps={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SubagentPhaseTimeline — completed row", () => {
  test("shows label + 'Worked for <dur>', hides pills by default, toggles on click", async () => {
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

    // Toggling back hides them — the collapse animates closed (height/opacity),
    // so the pills stay mounted through the exit transition; await their removal.
    fireEvent.click(header);
    await waitFor(() =>
      expect(queryAllByTestId("phase-step-pill").length).toBe(0),
    );
  });
});

describe("SubagentPhaseTimeline — running row", () => {
  test("renders the ThreeDotIndicator node and a Brain + live activity sub-label", () => {
    const steps: ToolCallCardStep[] = [
      bash("sleep 5", "running", "", "tc-a", "Compiling the project"),
    ];
    // A running phase implies a running subagent (the panel always passes this);
    // only then is the last phase the pulsing active tail.
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );

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
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const header = getByTestId("subagent-phase-header");
    expect(header.textContent).toContain("npm run build");
  });

  test("an in-flight web_search surfaces its query as the live sub-label", () => {
    // Title "Searching the web" → the phase reads as running; the running row's
    // sub-label is the search query, not the generic phase label.
    const steps: ToolCallCardStep[] = [
      webSearch([], "Searching the web", "best thermos 2025"),
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const header = getByTestId("subagent-phase-header");
    expect(header.textContent).toContain("best thermos 2025");
  });
});

describe("SubagentPhaseTimeline — running tail", () => {
  test("the last phase's node keeps pulsing when the subagent is running but its steps have settled", () => {
    // Settled bash phase + the subagent is still running → the node is the
    // pulsing ThreeDotIndicator (no `data-status`, 3 dot children), NOT a green
    // check — so the timeline shows ongoing work without a separate row.
    const steps: ToolCallCardStep[] = [bash("ls", "completed", "1s", "tc-a")];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const node = getByTestId("phase-header-status-icon");
    expect(node.getAttribute("data-status")).toBeNull();
    expect(node.children.length).toBe(3);
  });

  test("the last node shows its settled status when the subagent is NOT running", () => {
    const steps: ToolCallCardStep[] = [bash("ls", "completed", "1s", "tc-a")];
    const { getByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    const node = getByTestId("phase-header-status-icon");
    expect(node.getAttribute("data-status")).toBe("completed");
  });

  test("a non-last phase whose web_search never resolved does NOT pulse (coerced to settled)", () => {
    // The web_search keeps the present-tense title because its `tool_result`
    // never arrived, so phaseHeaderStatus reads it as "running". With a later
    // phase after it, it must read as settled — only the tail may pulse.
    const steps: ToolCallCardStep[] = [
      webSearch([], "Searching the web", "orphaned query"),
      bash("ls", "completed", "1s", "tc-a"),
    ];
    const { getAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const nodes = getAllByTestId("phase-header-status-icon");
    // The stuck search node is coerced to a completed check, not the pulse.
    expect(nodes[0]!.getAttribute("data-status")).toBe("completed");
    // The genuine tail (bash) pulses.
    const last = nodes[nodes.length - 1]!;
    expect(last.getAttribute("data-status")).toBeNull();
    expect(last.children.length).toBe(3);
  });

  test("an orphaned web_search does not pulse once the subagent is terminal", () => {
    // Same stuck search, but as the LAST phase with the subagent no longer
    // running — it must not pulse (the subagent is done).
    const steps: ToolCallCardStep[] = [
      webSearch([], "Searching the web", "orphaned query"),
    ];
    const { getByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    expect(
      getByTestId("phase-header-status-icon").getAttribute("data-status"),
    ).toBe("completed");
  });

  test("only the last phase pulses — earlier settled phases keep their status", () => {
    // Working → Thinking → Working. While running, only the final Working phase
    // pulses; the first Working stays a completed check.
    const steps: ToolCallCardStep[] = [
      bash("a", "completed", "1s", "tc-a"),
      thinking("t1"),
      bash("b", "completed", "1s", "tc-b"),
    ];
    const { getAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const nodes = getAllByTestId("phase-header-status-icon");
    expect(nodes[0]!.getAttribute("data-status")).toBe("completed");
    const last = nodes[nodes.length - 1]!;
    expect(last.getAttribute("data-status")).toBeNull();
    expect(last.children.length).toBe(3);
  });
});

describe("SubagentPhaseTimeline — running Thinking tail", () => {
  test("a running Thinking tail pulses (ThreeDotIndicator) instead of the static brain", () => {
    const steps: ToolCallCardStep[] = [
      thinking("Planning the research"),
      thinking("Reading adidas-group.com"),
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    // The node is the three-dot indicator — no `data-status`, 3 dot children —
    // NOT the static brain (which stamps `data-status="thinking"`).
    const node = getByTestId("phase-header-status-icon");
    expect(node.getAttribute("data-status")).toBeNull();
    expect(node.children.length).toBe(3);
  });

  test("a running Thinking tail surfaces its latest line in the trailing slot", () => {
    const steps: ToolCallCardStep[] = [
      thinking("Planning the research"),
      thinking("Reading adidas-group.com"),
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const header = getByTestId("subagent-phase-header");
    // The carousel carries the most recent thinking line, like a search row
    // carries its query.
    expect(header.textContent).toContain("Reading adidas-group.com");
  });

  test("a Thinking phase keeps the static brain when the subagent is NOT running", () => {
    const steps: ToolCallCardStep[] = [thinking("Done reasoning")];
    const { getByTestId } = render(<SubagentPhaseTimeline steps={steps} />);
    // Not the active tail → the brain (data-status="thinking"), not a pulse.
    expect(
      getByTestId("phase-header-status-icon").getAttribute("data-status"),
    ).toBe("thinking");
  });

  test("a non-tail Thinking phase keeps its brain; only the running tail pulses", () => {
    const steps: ToolCallCardStep[] = [
      thinking("Mid thought"),
      bash("ls", "running", "", "tc-a"),
    ];
    const { getAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    const nodes = getAllByTestId("phase-header-status-icon");
    // The earlier Thinking phase stays a brain; the bash tail is the pulse.
    expect(nodes[0]!.getAttribute("data-status")).toBe("thinking");
    const last = nodes[nodes.length - 1]!;
    expect(last.getAttribute("data-status")).toBeNull();
    expect(last.children.length).toBe(3);
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

describe("SubagentPhaseTimeline — single-step expandability", () => {
  // A single `tool_error` phase carries its message only in the step pill, so
  // the row is expandable even without an "N steps" pill and the error text
  // stays reachable.
  test("a single tool_error phase is expandable and reveals its error on click", () => {
    const steps: ToolCallCardStep[] = [toolError("context window exceeded")];
    const { getByTestId, queryByTestId, queryAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    const header = getByTestId("subagent-phase-header");
    // No "N steps" pill for a lone step, but the row is still interactive.
    expect(queryByTestId("subagent-phase-step-count")).toBeNull();
    expect(header.hasAttribute("disabled")).toBe(false);

    // Collapsed by default — the error message is hidden.
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);

    // Clicking reveals the lone error pill carrying the message.
    fireEvent.click(header);
    const pills = queryAllByTestId("phase-step-pill");
    expect(pills.length).toBe(1);
    expect(pills[0]!.textContent).toContain("context window exceeded");
  });

  // A lone successful tool step with no `info` renders a null `DefaultStepPill`
  // (nothing to reveal), so the row stays non-expandable — no toggle, disabled
  // header.
  test("a single info-less successful tool step is NOT expandable", () => {
    const steps: ToolCallCardStep[] = [bash("", "completed", "1s", "tc-a")];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    const header = getByTestId("subagent-phase-header");
    expect(header.hasAttribute("disabled")).toBe(true);
    expect(queryByTestId("subagent-phase-step-count")).toBeNull();

    // Clicking a disabled header does nothing — no pill ever appears.
    fireEvent.click(header);
    expect(queryByTestId("phase-step-pill")).toBeNull();
  });

  // A lone failing tool step with no `info` also renders a null
  // `DefaultStepPill` — `DefaultStepPill` ignores status when `info` is empty —
  // so the row stays non-expandable rather than expanding to an empty body.
  test("a single info-less error tool step is NOT expandable", () => {
    const steps: ToolCallCardStep[] = [bash("", "error", "1s", "tc-a")];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    const header = getByTestId("subagent-phase-header");
    expect(header.hasAttribute("disabled")).toBe(true);
    expect(queryByTestId("subagent-phase-step-count")).toBeNull();

    // Clicking the disabled header reveals nothing — no empty body.
    fireEvent.click(header);
    expect(queryByTestId("phase-step-pill")).toBeNull();
  });
});

describe("SubagentPhaseTimeline — clickable tool steps", () => {
  test("tool steps render as clickable buttons and call back with toolCallId", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];
    const { getByTestId, getAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));

    const pills = getAllByTestId("tool-step-pill");
    expect(pills.length).toBe(2);
    pills.forEach((pill) => expect(pill.tagName).toBe("BUTTON"));

    fireEvent.click(pills[0]!);
    expect(onStepDetailClick).toHaveBeenCalledTimes(1);
    expect(onStepDetailClick).toHaveBeenLastCalledWith("tc-a");

    fireEvent.click(pills[1]!);
    expect(onStepDetailClick).toHaveBeenLastCalledWith("tc-b");
  });

  // A clickable tool step whose labeler produced no `info` still renders a
  // `ToolStepPill` (its label falls back to `step.title`), so the row must be
  // expandable and the nested detail reachable. Regression for `isExpandable`
  // consulting only `stepRendersPill` — which is false for an info-less tool
  // step — and thus disabling the row even though the clickable arm would have
  // rendered a real pill.
  test("a single info-less tool step is expandable + clickable when a handler is wired", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [bash("", "completed", "1s", "tc-a")];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    const header = getByTestId("subagent-phase-header");
    expect(header.hasAttribute("disabled")).toBe(false);

    fireEvent.click(header);
    const pill = getByTestId("tool-step-pill");
    expect(pill.tagName).toBe("BUTTON");

    fireEvent.click(pill);
    expect(onStepDetailClick).toHaveBeenCalledTimes(1);
    expect(onStepDetailClick).toHaveBeenLastCalledWith("tc-a");
  });

  test("a thinking step WITHOUT a detail key is not clickable", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [thinking("Considering options")];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("a thinking step WITH a detail key renders a clickable pill and calls back", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      thinking("Considering options", "1s", "think-1"),
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    const pill = getByTestId("tool-step-pill");
    expect(pill.tagName).toBe("BUTTON");

    fireEvent.click(pill);
    expect(onStepDetailClick).toHaveBeenCalledTimes(1);
    expect(onStepDetailClick).toHaveBeenLastCalledWith("think-1");
  });

  test("a tool_error step does NOT render as a clickable tool pill", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [toolError("context window exceeded")];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("a web_search_error WITH a detail key renders a clickable error pill and calls back", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      {
        kind: "web_search_error",
        title: "Web search failed",
        durationLabel: "1s",
        errorMessage: "provider error 503",
        detailKey: "tu-ws",
      },
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    const pill = getByTestId("tool-step-pill");
    expect(pill.tagName).toBe("BUTTON");

    fireEvent.click(pill);
    expect(onStepDetailClick).toHaveBeenLastCalledWith("tu-ws");
  });

  test("a web_search_error WITHOUT a detail key falls back to the inline error chip", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      {
        kind: "web_search_error",
        title: "Web search failed",
        durationLabel: "1s",
        errorMessage: "provider error 503",
      },
    ];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    // No detail key → the non-clickable error chip, not a clickable pill.
    expect(queryByTestId("tool-step-pill")).toBeNull();
    expect(getByTestId("web-search-error-chip")).toBeDefined();
  });

  test("tool steps with an empty toolCallId stay non-clickable", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", ""),
      bash("pwd", "completed", "2s", ""),
    ];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("without the callback, tool steps remain non-clickable", () => {
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];
    const { getByTestId, queryByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("a web_search step WITH a detail key renders a clickable query pill and calls back", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      webSearch(
        [{ title: "R1", url: "https://a.com", domain: "a.com" }],
        "Searched the web",
        "best vector databases",
        "ws-1",
      ),
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    // The query renders as a single clickable tool pill (a button) that opens
    // the nested detail — NOT the inline web-source anchors.
    const pill = getByTestId("tool-step-pill");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.textContent).toContain("best vector databases");

    fireEvent.click(pill);
    expect(onStepDetailClick).toHaveBeenCalledTimes(1);
    expect(onStepDetailClick).toHaveBeenLastCalledWith("ws-1");
  });

  test("a web_search step WITHOUT a detail key falls back to inline source chips", () => {
    const onStepDetailClick = mock((_id: string) => {});
    const steps: ToolCallCardStep[] = [
      webSearch([
        { title: "R1", url: "https://a.com", domain: "a.com" },
        { title: "R2", url: "https://b.com", domain: "b.com" },
      ]),
    ];
    const { getByTestId, getAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} onStepDetailClick={onStepDetailClick} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    // No detailKey → the deploy-safe inline web chips (anchors), not a button,
    // and nothing to open.
    const chips = getAllByTestId("tool-step-pill");
    expect(chips.length).toBe(2);
    chips.forEach((chip) => expect(chip.tagName).toBe("A"));
    expect(onStepDetailClick).not.toHaveBeenCalled();
  });
});

describe("SubagentPhaseTimeline — web_search trailing query", () => {
  test("an in-flight search shows the most recent query to the right of the divider", () => {
    const steps: ToolCallCardStep[] = [
      webSearch(
        [{ title: "First Source", url: "https://a.com", domain: "a.com" }],
        "Searched the web",
        "thermos history",
      ),
      // The latest search is still in flight (no resolved query yet) → the phase
      // reads as running and falls back to the previous, known query.
      webSearch([], "Searching the web"),
    ];
    const { getByTestId } = render(
      <SubagentPhaseTimeline steps={steps} isRunning />,
    );
    expect(getByTestId("subagent-phase-header").textContent).toContain(
      "thermos history",
    );
  });

  test("a completed search shows its query in the trailing slot (not under the row)", () => {
    const steps: ToolCallCardStep[] = [
      webSearch(
        [{ title: "First Source", url: "https://a.com", domain: "a.com" }],
        "Searched the web",
        "best vacuum flask 2025",
      ),
    ];
    const { getByTestId, queryByText } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );
    // Query sits inline on the header row...
    expect(getByTestId("subagent-phase-header").textContent).toContain(
      "best vacuum flask 2025",
    );
    // ...and the result source is NOT rendered under the row (no ticker); it
    // only appears in the expandable detail.
    expect(queryByText("First Source")).toBeNull();
  });
});

describe("SubagentPhaseTimeline — web_search chips", () => {
  test("a web_search step renders its results as favicon link chips when expanded", () => {
    const steps: ToolCallCardStep[] = [
      webSearch([
        { title: "First Result", url: "https://example.com/a", domain: "example.com" },
        { title: "Second Result", url: "https://foo.org/b", domain: "foo.org" },
      ]),
      // A second search so the group is multi-step (has the "N steps" pill).
      webSearch([
        { title: "Third Result", url: "https://bar.net/c", domain: "bar.net" },
      ]),
    ];
    const { getByTestId, getAllByTestId, queryAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    // Both searches collapse into one "Searching the web" group.
    const section = getByTestId("subagent-phase-section");
    expect(section.getAttribute("data-phase-label")).toBe("Searching the web");

    // Collapsed by default — no chips.
    expect(queryAllByTestId("tool-step-pill").length).toBe(0);

    // Expanding reveals every result chip inline (no clamp): 2 + 1 = 3.
    fireEvent.click(getByTestId("subagent-phase-header"));
    const chips = getAllByTestId("tool-step-pill");
    expect(chips.length).toBe(3);
    chips.forEach((chip) => {
      // Web chips render as external-link anchors, not buttons.
      expect(chip.tagName).toBe("A");
      expect(chip.getAttribute("data-variant")).toBe("web");
    });
    expect(chips[0]!.getAttribute("href")).toBe("https://example.com/a");
    expect(chips[0]!.textContent).toContain("First Result");
    expect(chips[2]!.getAttribute("href")).toBe("https://bar.net/c");
  });

  test("labels each search with its query so multiple searches stay distinct", () => {
    const steps: ToolCallCardStep[] = [
      webSearch(
        [{ title: "R1", url: "https://a.com", domain: "a.com" }],
        "Searched the web",
        "most popular AI assistants 2026",
      ),
      webSearch(
        [{ title: "R2", url: "https://b.com", domain: "b.com" }],
        "Searched the web",
        "ChatGPT users market share 2026",
      ),
    ];
    const { getByTestId, container } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    fireEvent.click(getByTestId("subagent-phase-header"));
    // Both queries render as labels above their chip clusters.
    expect(container.textContent).toContain("most popular AI assistants 2026");
    expect(container.textContent).toContain("ChatGPT users market share 2026");
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

  // Regression: historical/older subagent events can carry an empty
  // `toolCallId` (`use-subagent-card-data.ts` maps `event.toolUseId ?? ""`).
  // Two same-label "Working" phases whose first steps both have empty
  // `toolCallId` must still get distinct section keys, so expanding one does
  // not expand the other.
  test("same-label phases with empty toolCallId expand/collapse independently", async () => {
    const steps: ToolCallCardStep[] = [
      // First "Working" group — empty toolCallId on every step.
      bash("ls", "completed", "1s", ""),
      bash("pwd", "completed", "1s", ""),
      // Thinking step splits the timeline into two "Working" sections.
      thinking("Considering options"),
      // Second "Working" group — also empty toolCallId.
      bash("cat x", "completed", "1s", ""),
      bash("cat y", "completed", "1s", ""),
    ];
    const { getAllByTestId, queryAllByTestId } = render(
      <SubagentPhaseTimeline steps={steps} />,
    );

    // Two distinct "Working" rows (plus the "Thinking" row between them).
    const sections = getAllByTestId("subagent-phase-section");
    const working = sections.filter(
      (s) => s.getAttribute("data-phase-label") === "Working",
    );
    expect(working.length).toBe(2);

    const headerOf = (section: Element) =>
      section.querySelector('[data-testid="subagent-phase-header"]')!;

    // Collapsed by default.
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);

    // Expanding the first "Working" row reveals only its 2 pills.
    fireEvent.click(headerOf(working[0]!));
    expect(queryAllByTestId("phase-step-pill").length).toBe(2);

    // Expanding the second "Working" row reveals its own 2 pills (4 total) —
    // the two same-label phases are keyed independently.
    fireEvent.click(headerOf(working[1]!));
    expect(queryAllByTestId("phase-step-pill").length).toBe(4);

    // Collapsing the first leaves the second's pills visible — the first row's
    // pills animate closed, so await the exit transition removing just those two.
    fireEvent.click(headerOf(working[0]!));
    await waitFor(() =>
      expect(queryAllByTestId("phase-step-pill").length).toBe(2),
    );
  });
});

describe("SubagentPhaseTimeline — controlled expand state", () => {
  // When `expandedKeys`/`onExpandedKeysChange` are supplied the parent owns the
  // expansion (so it can outlive an unmount): the component renders from the
  // prop and reports toggles instead of self-managing, and does not expand
  // until the parent feeds the new set back. `onExpandedKeysChange` receives a
  // functional updater (the `setState`-style contract that keeps the internal
  // `toggle` callback stable), so the next set is derived by applying it to the
  // previous one.
  test("renders expansion from `expandedKeys` and reports toggles to the parent", () => {
    const onExpandedKeysChange =
      mock((_updater: (prev: Set<string>) => Set<string>) => {});
    const steps: ToolCallCardStep[] = [
      bash("ls", "completed", "1s", "tc-a"),
      bash("pwd", "completed", "2s", "tc-b"),
    ];

    const { rerender, getByTestId, queryAllByTestId } = render(
      <SubagentPhaseTimeline
        steps={steps}
        expandedKeys={new Set()}
        onExpandedKeysChange={onExpandedKeysChange}
      />,
    );

    // Controlled + collapsed: no pills yet.
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);

    // Clicking the header reports an updater but does NOT self-expand.
    fireEvent.click(getByTestId("subagent-phase-header"));
    expect(onExpandedKeysChange).toHaveBeenCalledTimes(1);
    const updater = onExpandedKeysChange.mock.calls[0]![0];
    const nextKeys = updater(new Set());
    expect(nextKeys.size).toBe(1);
    expect(queryAllByTestId("phase-step-pill").length).toBe(0);

    // Feeding the derived set back expands the section.
    rerender(
      <SubagentPhaseTimeline
        steps={steps}
        expandedKeys={nextKeys}
        onExpandedKeysChange={onExpandedKeysChange}
      />,
    );
    expect(queryAllByTestId("phase-step-pill").length).toBe(2);
  });
});

describe("SubagentPhaseTimeline — row render isolation", () => {
  // `SubagentPhaseRow` is `React.memo`-wrapped, and both the `toggle` callback
  // and the parent's stable `onExpandedKeysChange` setter keep every prop a row
  // receives reference-stable across an expand/collapse and across a no-op
  // parent re-render. We count actual row renders by spying on
  // `phaseHeaderStatus`, which each row calls exactly once at the top of its
  // render — so the spy's call count is precisely the number of rows whose
  // render function ran. `spyOn` + `mockRestore` is local to this test (it does
  // NOT use `mock.module`), so it leaves no cross-file pollution.
  function toolStep(id: string): ToolCallCardStep {
    return bash(id, "completed", "1s", `tc-${id}`);
  }

  // Five phases: tool / thinking / tool / thinking / tool — each step kind
  // change opens a new phase, so this yields five independent rows.
  const FIVE_PHASE_STEPS: ToolCallCardStep[] = [
    toolStep("a"),
    thinking("t1"),
    toolStep("b"),
    thinking("t2"),
    toolStep("c"),
  ];

  test("toggling one phase re-renders only that row; a no-op parent re-render re-renders zero rows", () => {
    const renderSpy = spyOn(phaseGroupedStepList, "phaseHeaderStatus");
    try {
      // Harness owns the expanded state via a stable `setState` setter (the
      // contract the real panel uses) and exposes a `forceRerender` that bumps
      // unrelated state without touching the stable `steps` array — modelling a
      // parent re-render driven by an `entry` identity bump that didn't change
      // the projected steps.
      let forceRerender: () => void = () => {};
      function Harness() {
        const [expanded, setExpanded] = useState<Set<string>>(new Set());
        const [, setTick] = useState(0);
        forceRerender = () => setTick((n) => n + 1);
        return (
          <SubagentPhaseTimeline
            steps={FIVE_PHASE_STEPS}
            expandedKeys={expanded}
            onExpandedKeysChange={setExpanded}
          />
        );
      }

      const { getAllByTestId } = render(<Harness />);

      // Mount renders every row once.
      const rows = getAllByTestId("subagent-phase-header");
      expect(rows.length).toBe(5);
      expect(renderSpy.mock.calls.length).toBe(5);

      // Toggling one phase open re-renders ONLY that row (the memoized siblings
      // bail because `section`, `onToggle`, and `onStepDetailClick` are all
      // reference-stable).
      renderSpy.mockClear();
      fireEvent.click(rows[0]!);
      expect(renderSpy.mock.calls.length).toBe(1);

      // Toggling it back also re-renders only that one row.
      renderSpy.mockClear();
      fireEvent.click(rows[0]!);
      expect(renderSpy.mock.calls.length).toBe(1);

      // A parent re-render that leaves `steps` (and thus the memoized `sections`
      // array) reference-stable re-renders ZERO rows.
      renderSpy.mockClear();
      forceRerender();
      expect(renderSpy.mock.calls.length).toBe(0);
    } finally {
      renderSpy.mockRestore();
    }
  });
});
