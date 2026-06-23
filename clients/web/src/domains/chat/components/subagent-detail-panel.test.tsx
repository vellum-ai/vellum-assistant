/**
 * The detail panel's Input/Output/Cost cards always render their real
 * formatted values. The metrics stream in as the subagent makes LLM calls, so
 * the cards start at `0` / `0.00` and tick up — there are no skeleton loading
 * states, even while the subagent is still running with zeroed usage.
 *
 * Heavy children (avatar, status badge, timeline) are stubbed so we can assert
 * the metric-row behavior without depending on their internals.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <div data-testid="avatar" />,
}));

mock.module("@/domains/chat/components/subagent-status-badge", () => ({
  StatusBadge: ({ status }: { status: string }) => (
    <div data-testid="status-badge" data-status={status} />
  ),
}));

// The real timeline is exercised in its own test; here we stub it so the panel
// tests stay focused on the panel's own behavior. The stub renders a button
// that forwards a fixed tool-call id to the panel's `onToolStepClick`, letting
// us drive the nested tool-detail swap without depending on the timeline's
// expand/pill internals.
mock.module("@/domains/chat/components/subagent-phase-timeline", () => ({
  SubagentPhaseTimeline: ({
    onToolStepClick,
    expandedKeys,
    onExpandedKeysChange,
  }: {
    onToolStepClick?: (toolCallId: string) => void;
    expandedKeys?: Set<string>;
    onExpandedKeysChange?: (next: Set<string>) => void;
  }) => (
    <div data-testid="timeline">
      {/* Surfaces the controlled expand state so a test can assert the panel
          preserves it across the tool-detail view swap. */}
      <button
        type="button"
        data-testid="timeline-expand"
        onClick={() =>
          onExpandedKeysChange?.(new Set(expandedKeys).add("grp-1"))
        }
      >
        {expandedKeys?.has("grp-1") ? "group-open" : "group-closed"}
      </button>
      <button
        type="button"
        data-testid="timeline-pill"
        onClick={() => onToolStepClick?.("tool-1")}
      >
        pill
      </button>
    </div>
  ),
}));

import { SubagentDetailPanel } from "@/domains/chat/components/subagent-detail-panel";
import type { SubagentEntry } from "@/domains/chat/subagent-store";

const noop = () => {};

function makeEntry(overrides: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    subagentId: "sub-1",
    label: "Research agent",
    objective: "Do the thing",
    status: "running",
    isFork: false,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    spawnedAt: Date.now(),
    events: [],
    ...overrides,
  };
}

/** Skeleton bars (if any) pulse; real values are plain text. */
function skeletonCount(container: HTMLElement): number {
  return container.querySelectorAll(".animate-pulse").length;
}

afterEach(() => {
  cleanup();
});
afterAll(() => {
  mock.restore();
});

describe("SubagentDetailPanel — metric cards", () => {
  test("running with zero usage renders real zeros, not skeletons", () => {
    const { container } = render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "running", inputTokens: 0, outputTokens: 0, totalCost: 0 })}
        onClose={noop}
      />,
    );

    expect(skeletonCount(container)).toBe(0);
    expect(screen.getByText("Input")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Cost")).toBeDefined();
    // Live values render immediately: two "0" tokens and one "0.00" cost.
    expect(screen.getAllByText("0").length).toBe(2);
    expect(screen.getByText("0.00")).toBeDefined();
  });

  test("running with usage renders real values", () => {
    const { container } = render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "running", inputTokens: 1200, outputTokens: 340, totalCost: 0.68 })}
        onClose={noop}
      />,
    );

    expect(skeletonCount(container)).toBe(0);
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("340")).toBeDefined();
    expect(screen.getByText("0.68")).toBeDefined();
  });

  test("terminal subagent renders real values including a legitimate zero", () => {
    const { container } = render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "completed", inputTokens: 0, outputTokens: 0, totalCost: 0 })}
        onClose={noop}
      />,
    );

    expect(skeletonCount(container)).toBe(0);
    // Two "0" inputs/outputs and one "0.00" cost render as real text.
    expect(screen.getAllByText("0").length).toBe(2);
    expect(screen.getByText("0.00")).toBeDefined();
  });
});

describe("SubagentDetailPanel — timeline empty state", () => {
  test("empty events renders 'No events yet'", () => {
    render(<SubagentDetailPanel entry={makeEntry({ events: [] })} onClose={noop} />);
    expect(screen.getByText("No events yet")).toBeDefined();
    expect(screen.queryByTestId("timeline")).toBeNull();
  });

  test("non-empty events that project to zero steps do NOT render 'No events yet'", () => {
    // A lone `tool_result` with no preceding in-flight `tool_call` is
    // intentionally dropped by `computeSubagentCardData`, so `steps` is
    // empty while `entry.events` is non-empty. The empty state must gate on
    // raw events, so "No events yet" must NOT appear (and the timeline
    // renders — a no-op for zero steps).
    render(
      <SubagentDetailPanel
        entry={makeEntry({
          events: [
            {
              id: "te-orphan",
              type: "tool_result",
              content: "ok",
              toolName: "bash",
              timestamp: Date.now(),
            },
          ],
        })}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("No events yet")).toBeNull();
    expect(screen.getByTestId("timeline")).toBeDefined();
  });
});

describe("SubagentDetailPanel — header controls", () => {
  test("Stop button renders only while running and calls onStop", () => {
    const stopped: string[] = [];
    render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "running" })}
        onClose={noop}
        onStop={(id) => stopped.push(id)}
      />,
    );

    const stopButton = screen.getByLabelText("Stop subagent");
    fireEvent.click(stopButton);
    expect(stopped).toEqual(["sub-1"]);
  });

  test("Stop button is hidden for a terminal subagent", () => {
    render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "completed" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop subagent")).toBeNull();
  });

  test("close button fires onClose", () => {
    let closed = 0;
    render(
      <SubagentDetailPanel
        entry={makeEntry()}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close subagent detail"));
    expect(closed).toBe(1);
  });
});

/**
 * happy-dom does not compute real layout, so a ref'd element's `scrollHeight`
 * and `clientHeight` are both `0` — the overflow check
 * (`scrollHeight > clientHeight`) would never fire and the "Show more" toggle
 * would never render. To exercise the collapse/expand path deterministically
 * we stub the two getters on `HTMLElement.prototype`: when the objective body
 * is "tall" we report `scrollHeight > clientHeight`; otherwise we report them
 * equal (no overflow). The stub keys off the rendered text so the same prototype
 * patch drives both the overflow and the no-overflow cases. `installOverflow`
 * returns a restore fn the test calls in a `finally`.
 */
function installOverflow(overflowingText: string) {
  const scrollDesc = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const clientDesc = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 60; // ~3 clamped lines
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      // The objective body overflows only when it holds the long text.
      return this.textContent === overflowingText ? 240 : 60;
    },
  });

  return () => {
    if (scrollDesc) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDesc);
    } else {
      // @ts-expect-error — happy-dom defines no own descriptor by default.
      delete HTMLElement.prototype.scrollHeight;
    }
    if (clientDesc) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientDesc);
    } else {
      // @ts-expect-error — happy-dom defines no own descriptor by default.
      delete HTMLElement.prototype.clientHeight;
    }
  };
}

describe("SubagentDetailPanel — objective", () => {
  test("a long objective shows a toggle that expands and collapses the body", () => {
    const longObjective = "x ".repeat(400).trim();
    const restore = installOverflow(longObjective);
    try {
      render(
        <SubagentDetailPanel
          entry={makeEntry({ objective: longObjective })}
          onClose={noop}
        />,
      );

      const body = screen.getByText(longObjective);
      // Collapsed by default: clamped and offering "Show more".
      expect(body.className).toContain("line-clamp-3");
      const toggle = screen.getByText("Show more");

      fireEvent.click(toggle);
      // Expanded: clamp removed and the affordance flips to "Show less".
      expect(screen.getByText("Show less")).toBeDefined();
      expect(screen.getByText(longObjective).className).not.toContain(
        "line-clamp-3",
      );

      fireEvent.click(screen.getByText("Show less"));
      expect(screen.getByText("Show more")).toBeDefined();
    } finally {
      restore();
    }
  });

  test("a short objective renders no toggle", () => {
    const restore = installOverflow("never-matches");
    try {
      render(
        <SubagentDetailPanel
          entry={makeEntry({ objective: "Short" })}
          onClose={noop}
        />,
      );
      expect(screen.getByText("Short")).toBeDefined();
      expect(screen.queryByText("Show more")).toBeNull();
      expect(screen.queryByText("Show less")).toBeNull();
    } finally {
      restore();
    }
  });

  test("switching to a different subagent resets the expanded objective state", () => {
    // The desktop parent reuses this component instance across subagent
    // switches (no React `key`). Expand the first subagent's long objective,
    // then re-render the SAME instance with a different subagent whose
    // objective is short. The expand state must reset and re-measure: the new
    // objective renders collapsed with no toggle.
    const longObjective = "x ".repeat(400).trim();
    const restore = installOverflow(longObjective);
    try {
      const { rerender } = render(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-1", objective: longObjective })}
          onClose={noop}
        />,
      );

      // Expand the first subagent's objective.
      fireEvent.click(screen.getByText("Show more"));
      expect(screen.getByText("Show less")).toBeDefined();
      expect(screen.getByText(longObjective).className).not.toContain(
        "line-clamp-3",
      );

      // Switch to a different subagent with a short objective. Same instance,
      // different `entry.subagentId`.
      rerender(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-2", objective: "Short" })}
          onClose={noop}
        />,
      );

      // State reset + re-measured: collapsed, no stale "Show less"/toggle.
      const shortBody = screen.getByText("Short");
      expect(shortBody.className).toContain("line-clamp-3");
      expect(screen.queryByText("Show less")).toBeNull();
      expect(screen.queryByText("Show more")).toBeNull();
    } finally {
      restore();
    }
  });

  test("re-measures overflow when switching to a different subagent with identical objective text", () => {
    // The render-phase reset forces `objectiveOverflows` to `false` on every
    // subagent switch. If the measurement effect only depended on the
    // objective text + expanded flag, switching from subagent A to a DIFFERENT
    // subagent B with byte-identical (still overflowing) objective text would
    // change neither dep, the effect would skip, and the toggle would vanish.
    // Depending on `entry.subagentId` forces a re-measure so "Show more"
    // survives the switch.
    const longObjective = "x ".repeat(400).trim();
    const restore = installOverflow(longObjective);
    try {
      const { rerender } = render(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-1", objective: longObjective })}
          onClose={noop}
        />,
      );

      // Subagent A: overflowing objective offers the toggle.
      expect(screen.getByText("Show more")).toBeDefined();

      // Switch to a DIFFERENT subagent with an IDENTICAL objective string.
      rerender(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-2", objective: longObjective })}
          onClose={noop}
        />,
      );

      // Re-measured despite identical text: the toggle is still present.
      expect(screen.getByText("Show more")).toBeDefined();
      expect(screen.getByText(longObjective).className).toContain(
        "line-clamp-3",
      );
    } finally {
      restore();
    }
  });
});

/**
 * A `tool_call`/`tool_result` pair whose `toolUseId` matches the id the stubbed
 * timeline forwards (`tool-1`), so `buildSubagentToolDetails(entry)` produces a
 * payload the panel can swap into. `completed` overrides whether the call has a
 * result (closed) or is still in flight (running output state).
 */
function entryWithTool(completed: boolean): SubagentEntry {
  const now = Date.now();
  return makeEntry({
    events: [
      {
        id: "te-call",
        type: "tool_call",
        content: "ls -la",
        toolName: "bash",
        toolUseId: "tool-1",
        input: { command: "ls -la" },
        timestamp: now,
      },
      ...(completed
        ? [
            {
              id: "te-result",
              type: "tool_result" as const,
              content: "file-listing-output",
              result: "file-listing-output",
              toolName: "bash",
              toolUseId: "tool-1",
              timestamp: now + 1000,
            },
          ]
        : []),
    ],
  });
}

describe("SubagentDetailPanel — nested tool detail", () => {
  test("clicking a timeline tool pill swaps the body to the tool detail while keeping the header", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    // Timeline view first.
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByText("Back")).toBeNull();

    fireEvent.click(screen.getByTestId("timeline-pill"));

    // Detail body is shown (tool input + Output sections). The nested view
    // omits the "Technical details" label — redundant under the subagent
    // header + "Back" affordance — so it must NOT appear.
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("file-listing-output")).toBeDefined();
    // Timeline is no longer rendered (body swapped, not stacked).
    expect(screen.queryByTestId("timeline")).toBeNull();
    // The subagent header stays mounted in the detail view.
    expect(screen.getByText("Research agent")).toBeDefined();
    expect(screen.getByLabelText("Close subagent detail")).toBeDefined();
  });

  test("'Back' restores the timeline view", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();

    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByText("Back")).toBeNull();
  });

  test("selecting a still-running tool shows the 'Running…' output state", () => {
    render(<SubagentDetailPanel entry={entryWithTool(false)} onClose={noop} />);

    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Running…")).toBeDefined();
  });

  test("returning via 'Back' preserves the expanded timeline group", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    // Expand a group.
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-closed",
    );
    fireEvent.click(screen.getByTestId("timeline-expand"));
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-open",
    );

    // Open a tool's detail (the timeline unmounts) then return via "Back".
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();
    fireEvent.click(screen.getByText("Back"));

    // The group the user had open is still expanded — the lifted expand state
    // survived the timeline unmounting.
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-open",
    );
  });

  test("switching to a different subagent resets the nested view and expanded groups", () => {
    // The desktop parent reuses this instance across subagent switches (no
    // React `key`), so neither an open nested detail nor an expanded group may
    // leak onto the next subagent.
    const { rerender } = render(
      <SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />,
    );

    fireEvent.click(screen.getByTestId("timeline-expand"));
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();

    rerender(
      <SubagentDetailPanel
        entry={{ ...entryWithTool(true), subagentId: "sub-2" }}
        onClose={noop}
      />,
    );

    // Reset to the timeline for the new subagent, with no leaked detail or
    // expansion.
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByText("Back")).toBeNull();
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-closed",
    );
  });
});
