/**
 * The detail panel renders the run header (label + status badge) and a live
 * leaf tree. Each leaf row is keyed by `seq` and shows a status icon that
 * resolves in place — a spinner while running, a check when completed, an
 * alert when failed. When a run has no leaves yet, the panel asks its host to
 * fetch the journal.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

mock.module("@/domains/chat/components/workflow-status-badge", () => ({
  WorkflowStatusBadge: ({ status }: { status: string }) => (
    <div data-testid="status-badge" data-status={status} />
  ),
}));

import { WorkflowDetailPanel } from "@/domains/chat/components/workflow-detail-panel";
import type {
  WorkflowEntry,
  WorkflowLeaf,
} from "@/domains/chat/workflow-store";

const noop = () => {};

function makeLeaf(overrides: Partial<WorkflowLeaf> & { seq: number }): WorkflowLeaf {
  return {
    status: "running",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return {
    runId: "run-1",
    label: "Research workflow",
    status: "running",
    agentsSpawned: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: Date.now(),
    leaves: new Map(),
    ...overrides,
  };
}

function leafMap(leaves: WorkflowLeaf[]): Map<number, WorkflowLeaf> {
  return new Map(leaves.map((leaf) => [leaf.seq, leaf]));
}

afterEach(() => {
  cleanup();
});
afterAll(() => {
  mock.restore();
});

describe("WorkflowDetailPanel", () => {
  test("renders the header label and status badge", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ label: "Research workflow", status: "running" })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("Research workflow")).toBeDefined();
    const badge = screen.getByTestId("status-badge");
    expect(badge.getAttribute("data-status")).toBe("running");
  });

  test("falls back to the runId when no label is set", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ label: undefined, runId: "run-xyz" })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("run-xyz")).toBeDefined();
  });

  test("renders one row per leaf with the correct status icon", () => {
    const { container } = render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({ seq: 0, label: "Running leaf", status: "running" }),
            makeLeaf({ seq: 1, label: "Done leaf", status: "completed" }),
            makeLeaf({ seq: 2, label: "Broken leaf", status: "failed" }),
          ]),
        })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("Running leaf")).toBeDefined();
    expect(screen.getByText("Done leaf")).toBeDefined();
    expect(screen.getByText("Broken leaf")).toBeDefined();

    // The running leaf shows a spinner.
    expect(container.querySelectorAll(".animate-spin").length).toBe(1);
  });

  test("calls onRequestJournal when the run has no leaves", () => {
    let requested: string | undefined;
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-empty", leaves: new Map() })}
        onClose={noop}
        onRequestJournal={(runId) => {
          requested = runId;
        }}
      />,
    );

    expect(requested).toBe("run-empty");
  });

  test("does not call onRequestJournal when leaves are present", () => {
    let called = false;
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ leaves: leafMap([makeLeaf({ seq: 0 })]) })}
        onClose={noop}
        onRequestJournal={() => {
          called = true;
        }}
      />,
    );

    expect(called).toBe(false);
  });

  test("shows the Stop button only for an active run", () => {
    const { rerender } = render(
      <WorkflowDetailPanel
        entry={makeEntry({ status: "running" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop workflow")).not.toBeNull();

    rerender(
      <WorkflowDetailPanel
        entry={makeEntry({ status: "completed" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop workflow")).toBeNull();
  });
});
