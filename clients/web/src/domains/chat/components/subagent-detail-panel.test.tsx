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
import { cleanup, render, screen } from "@testing-library/react";

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
