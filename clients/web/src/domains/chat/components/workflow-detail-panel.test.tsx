/**
 * The detail panel renders the run header (label + status badge) and a live
 * leaf tree. Each leaf row is keyed by `seq` and shows a status icon that
 * resolves in place — a spinner while running, a check when completed, an
 * alert when failed. The panel asks its host to fetch the journal on open
 * and again when the run reaches a terminal state, reconciling leaves a
 * dropped SSE event left stale.
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

  test("renders the neutral cancelled icon for a cancelled leaf", () => {
    const { container } = render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({ seq: 0, label: "Cancelled leaf", status: "cancelled" }),
          ]),
        })}
        onClose={noop}
      />,
    );

    // The cancelled icon carries an accessible "Cancelled" label and is
    // neither the spinner nor the error icon.
    expect(screen.getByLabelText("Cancelled")).toBeDefined();
    expect(container.querySelectorAll(".animate-spin").length).toBe(0);
  });

  test("requests the journal on open even when leaves are already present", () => {
    const requested: string[] = [];
    render(
      <WorkflowDetailPanel
        entry={makeEntry({
          runId: "run-open",
          leaves: leafMap([makeLeaf({ seq: 0 })]),
        })}
        onClose={noop}
        onRequestJournal={(runId) => {
          requested.push(runId);
        }}
      />,
    );

    expect(requested).toEqual(["run-open"]);
  });

  test("requests the journal again when the run transitions to terminal", () => {
    const requested: string[] = [];
    const onRequestJournal = (runId: string) => {
      requested.push(runId);
    };
    const { rerender } = render(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-final", status: "running" })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );
    expect(requested).toEqual(["run-final"]);

    rerender(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-final", status: "completed" })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );
    // One fetch on open (live) + one on the live→terminal transition.
    expect(requested).toEqual(["run-final", "run-final"]);
  });

  test("does not re-request the journal across renders within the same phase", () => {
    const requested: string[] = [];
    const onRequestJournal = (runId: string) => {
      requested.push(runId);
    };
    const { rerender } = render(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-stable", status: "running" })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );

    rerender(
      <WorkflowDetailPanel
        entry={makeEntry({
          runId: "run-stable",
          status: "running",
          leaves: leafMap([makeLeaf({ seq: 0 })]),
        })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );

    // Same run, same (live) phase — the effect's deps are unchanged.
    expect(requested).toEqual(["run-stable"]);
  });

  test("renders the latest log message near the phase banner", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ phase: "Executing", message: "halfway there" })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("Executing")).toBeDefined();
    expect(screen.getByText("halfway there")).toBeDefined();
  });

  test("renders a log message even when no phase is set", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ phase: undefined, message: "still working" })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("still working")).toBeDefined();
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
