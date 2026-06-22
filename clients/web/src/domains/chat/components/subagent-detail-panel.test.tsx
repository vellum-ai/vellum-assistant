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

mock.module("@/domains/chat/components/subagent-phase-timeline", () => ({
  SubagentPhaseTimeline: () => <div data-testid="timeline" />,
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
});
